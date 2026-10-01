import { computed, ref } from 'vue'
import { applyMerge, clone, diffDocuments, planMerge, uid } from './patch'
import { sampleDocument } from './sample'
import {
  PersistError,
  clearCheckpoint,
  loadDraftStore,
  loadFrozen,
  loadPatches,
  migrateLegacyState,
  recoverFromCheckpoint,
  saveStores,
  writeCheckpoint
} from './storage'
import type { Cue, CueKind, DraftStore, FrozenVersion, Patch, Scene, StudioDocument, WarningItem } from './types'

interface Bootstrap {
  draft: DraftStore
  patches: Patch[]
  frozen: FrozenVersion[]
  recovered: boolean
  migrated: boolean
}

function bootstrap(): Bootstrap {
  // 上次一批写入中途失败：先把检查点（原稿 + 原补丁）恢复回来
  const recovered = recoverFromCheckpoint()
  let draft = loadDraftStore()
  let patches = loadPatches()
  let frozen = loadFrozen()
  let migrated = false
  if (!draft) {
    // 旧版只有整份快照：转成补丁继续用
    const legacy = migrateLegacyState()
    if (legacy) {
      draft = legacy.draft
      patches = legacy.patches
      frozen = legacy.frozen
      migrated = true
    }
  }
  if (!draft) {
    draft = {
      rev: 0,
      document: clone(sampleDocument),
      appliedBatches: [],
      updatedAt: new Date().toISOString()
    }
  }
  return { draft, patches, frozen, recovered, migrated }
}

export function useStudio() {
  const boot = bootstrap()
  const draft = ref<DraftStore>(boot.draft)
  const patches = ref<Patch[]>(boot.patches)
  const frozen = ref<FrozenVersion[]>(boot.frozen)
  const selectedSceneId = ref(draft.value.document.scenes[0]?.id ?? '')
  const selectedCueId = ref('')
  const saveState = ref<'saved' | 'saving' | 'error'>('saved')
  const saveError = ref('')
  const notice = ref(
    boot.recovered
      ? '检测到上次一批写入未完成，已从检查点恢复原稿与待确认补丁，未重复生效。'
      : boot.migrated
        ? '旧版整份快照已逐条转换为补丁，可继续接受或退回。'
        : ''
  )
  const undoStack = ref<StudioDocument[]>([])
  const redoStack = ref<StudioDocument[]>([])

  const selectedScene = computed(() => draft.value.document.scenes.find((scene) => scene.id === selectedSceneId.value) ?? draft.value.document.scenes[0])

  function durationOfCue(cue: Cue): number {
    if (cue.manualDuration !== undefined) return cue.manualDuration
    if (cue.kind === 'sfx') {
      return draft.value.document.soundEffects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
    }
    if (cue.kind === 'transition') return 3
    const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
    const effectiveRate = cue.rate || 1
    return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
  }

  function durationOfScene(scene: Scene): number {
    return Number(scene.cues.reduce((total, cue) => total + durationOfCue(cue), 0).toFixed(1))
  }

  const totalDuration = computed(() => draft.value.document.scenes.reduce((total, scene) => total + durationOfScene(scene), 0))
  const pendingChanges = computed(() => patches.value.filter((item) => item.status === 'pending' || item.status === 'conflict'))

  const warnings = computed<WarningItem[]>(() => {
    const result: WarningItem[] = []
    for (const scene of draft.value.document.scenes) {
      const actorRoles = new Map<string, string[]>()
      for (const cue of scene.cues) {
        if (cue.kind === 'dialogue' && cue.characterId) {
          const character = draft.value.document.characters.find((item) => item.id === cue.characterId)
          if (character) {
            const roles = actorRoles.get(character.voiceActor) ?? []
            roles.push(character.name)
            actorRoles.set(character.voiceActor, roles)
          }
        }
        if (cue.kind === 'sfx' && cue.soundEffectId && !draft.value.document.soundEffects.some((effect) => effect.id === cue.soundEffectId)) {
          result.push({
            id: `missing-${cue.id}`,
            type: 'missing-sfx',
            level: 'error',
            sceneId: scene.id,
            cueId: cue.id,
            title: `${scene.code} 音效引用缺失`,
            detail: `“${cue.text}”引用了不存在的音效 ${cue.soundEffectId}。`
          })
        }
      }
      actorRoles.forEach((roles, actor) => {
        const uniqueRoles = [...new Set(roles)]
        if (uniqueRoles.length > 1) {
          result.push({
            id: `collision-${scene.id}-${actor}`,
            type: 'collision',
            level: 'error',
            sceneId: scene.id,
            title: `${scene.code} 角色撞场`,
            detail: `${actor} 同时为 ${uniqueRoles.join('、')} 配音；同场角色需拆分演员或调整台词。`
          })
        }
      })
      const sceneDuration = durationOfScene(scene)
      if (sceneDuration > scene.durationLimit) {
        result.push({
          id: `over-${scene.id}`,
          type: 'over-time',
          level: 'warning',
          sceneId: scene.id,
          title: `${scene.code} 超出场次限额`,
          detail: `预计 ${sceneDuration.toFixed(1)} 秒，限额 ${scene.durationLimit} 秒，超出 ${(sceneDuration - scene.durationLimit).toFixed(1)} 秒。`
        })
      }
    }
    return result
  })

  /** 落盘当前内存状态；失败时检查点与原稿都还在存储里，可重试。 */
  function persist() {
    saveState.value = 'saving'
    try {
      saveStores(draft.value, patches.value, frozen.value)
      clearCheckpoint()
      saveState.value = 'saved'
      saveError.value = ''
    } catch (error) {
      saveState.value = 'error'
      saveError.value = error instanceof PersistError ? error.message : String(error)
    }
  }

  /** 写入失败后重试：同一批内容原样重写，不会重复生效。 */
  function retryPersist() {
    persist()
  }

  /**
   * 一批修改（一条补丁的提交 / 接受 / 退回 / 合入）的事务：
   * 先写检查点留住原稿，再改内存，最后落盘并登记批次号。
   * 同一批次号重试时直接跳过，保证不会重复生效。
   */
  function runBatch(batchId: string, label: string, mutate: () => void): boolean {
    if (draft.value.appliedBatches.includes(batchId)) return false
    writeCheckpoint({
      batchId,
      label,
      savedAt: new Date().toISOString(),
      draft: clone(draft.value),
      patches: clone(patches.value),
      frozen: clone(frozen.value)
    })
    mutate()
    draft.value.appliedBatches = [...draft.value.appliedBatches, batchId].slice(-200)
    draft.value.updatedAt = new Date().toISOString()
    persist()
    return true
  }

  function stagePatch(label: string, note: string, before: StudioDocument, after: StudioDocument) {
    const ops = diffDocuments(before, after)
    if (!ops.length) return
    const patch: Patch = {
      id: uid('patch'),
      label,
      note,
      createdAt: new Date().toISOString(),
      baseRev: draft.value.rev,
      ops,
      status: 'pending'
    }
    runBatch(patch.id, label, () => {
      draft.value.document = clone(after)
      draft.value.rev += 1
      patches.value.unshift(patch)
      if (patches.value.length > 120) patches.value = patches.value.slice(0, 120)
    })
  }

  function commit(label: string, mutator: (document: StudioDocument) => void, note = '') {
    const before = clone(draft.value.document)
    const after = clone(before)
    mutator(after)
    if (JSON.stringify(before) === JSON.stringify(after)) return
    undoStack.value.push(before)
    if (undoStack.value.length > 60) undoStack.value.shift()
    redoStack.value = []
    stagePatch(label, note, before, after)
  }

  function replaceDocument(next: StudioDocument, label: string) {
    stagePatch(label, '', clone(draft.value.document), clone(next))
  }

  function updateProject(field: 'title' | 'subtitle' | 'targetDuration', value: string | number) {
    commit(`更新项目${field === 'title' ? '标题' : field === 'subtitle' ? '副标题' : '目标时长'}`, (document) => {
      if (field === 'targetDuration') document.targetDuration = Number(value)
      else document[field] = String(value)
    })
  }

  function updateScene(sceneId: string, field: keyof Scene, value: string | number) {
    commit(`更新 ${draft.value.document.scenes.find((scene) => scene.id === sceneId)?.code ?? '场次'} ${field}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (field === 'durationLimit') scene.durationLimit = Number(value)
      else if (field === 'code' || field === 'title' || field === 'location' || field === 'timeOfDay' || field === 'transition') scene[field] = String(value)
    })
  }

  function updateCue(cueId: string, field: keyof Cue, value: string | number | undefined) {
    commit(`修改台词 ${draft.value.document.scenes.flatMap((scene) => scene.cues).find((cue) => cue.id === cueId)?.text.slice(0, 12) ?? ''}`, (document) => {
      for (const scene of document.scenes) {
        const cue = scene.cues.find((item) => item.id === cueId)
        if (!cue) continue
        if (field === 'rate') cue.rate = Number(value) as Cue['rate']
        else if (field === 'manualDuration') cue.manualDuration = value === '' || value === undefined ? undefined : Number(value)
        else if (field === 'kind') cue.kind = value as CueKind
        else cue[field] = (value ?? '') as never
        break
      }
    })
  }

  function addScene() {
    const nextNumber = draft.value.document.scenes.length + 1
    const id = uid('scene')
    commit(`新增场次 S${String(nextNumber).padStart(2, '0')}`, (document) => {
      document.scenes.push({
        id,
        code: `S${String(nextNumber).padStart(2, '0')}`,
        title: '未命名场次',
        location: '待填写',
        timeOfDay: '待填写',
        transition: '淡入',
        durationLimit: 150,
        cues: []
      })
    })
    selectedSceneId.value = id
  }

  function deleteScene(sceneId: string) {
    if (draft.value.document.scenes.length <= 1) return
    const scene = draft.value.document.scenes.find((item) => item.id === sceneId)
    commit(`删除场次 ${scene?.code ?? ''}`, (document) => {
      document.scenes = document.scenes.filter((item) => item.id !== sceneId)
    })
    selectedSceneId.value = draft.value.document.scenes[0].id
  }

  function addCue(kind: CueKind, sceneId = selectedSceneId.value) {
    const id = uid('cue')
    commit(`新增${kind === 'dialogue' ? '台词' : kind === 'sfx' ? '音效' : '转场'}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      scene.cues.push({
        id,
        kind,
        characterId: kind === 'dialogue' ? document.characters[0]?.id : undefined,
        text: kind === 'dialogue' ? '请输入台词' : kind === 'sfx' ? '音效提示' : '转场说明',
        emotion: kind === 'dialogue' ? '自然' : '',
        rate: 1,
        soundEffectId: kind === 'sfx' ? document.soundEffects[0]?.id : undefined,
        transition: kind === 'transition' ? '淡出' : '',
        manualDuration: kind === 'transition' ? 3 : undefined
      })
    })
    selectedCueId.value = id
  }

  function deleteCue(cueId: string) {
    commit('删除提示项', (document) => {
      for (const scene of document.scenes) scene.cues = scene.cues.filter((cue) => cue.id !== cueId)
    })
  }

  function moveCue(sceneId: string, cueId: string, targetCueId: string) {
    if (cueId === targetCueId) return
    commit('拖动调整台词与音效顺序', (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const fromIndex = scene.cues.findIndex((cue) => cue.id === cueId)
      const toIndex = scene.cues.findIndex((cue) => cue.id === targetCueId)
      if (fromIndex < 0 || toIndex < 0) return
      const [moved] = scene.cues.splice(fromIndex, 1)
      scene.cues.splice(toIndex, 0, moved)
    })
  }

  function moveScene(sceneId: string, direction: -1 | 1) {
    const index = draft.value.document.scenes.findIndex((scene) => scene.id === sceneId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= draft.value.document.scenes.length) return
    commit('调整场次顺序', (document) => {
      const [scene] = document.scenes.splice(index, 1)
      document.scenes.splice(target, 0, scene)
    })
  }

  /** 接受：把补丁按台词 / 音效逐条合入当前草稿；同一条被双方改过则挂起待选定。 */
  function acceptChange(patchId: string) {
    const patch = patches.value.find((item) => item.id === patchId)
    if (!patch || patch.status !== 'pending') return
    const { clean, conflicts } = planMerge(draft.value.document, patch, 'accept')
    if (conflicts.length) {
      runBatch(uid('batch'), `合入冲突：${patch.label}`, () => {
        patch.status = 'conflict'
        patch.merge = { action: 'accept', conflicts }
      })
      return
    }
    runBatch(uid('batch'), `接受：${patch.label}`, () => {
      if (clean.length) {
        draft.value.document = applyMerge(draft.value.document, patch, clean, [])
        draft.value.rev += 1
      }
      patch.status = 'accepted'
      patch.resolvedAt = new Date().toISOString()
    })
  }

  /** 退回：只撤回这条补丁触及的内容，不再整稿回退、不连带其他补丁。 */
  function rejectChange(patchId: string) {
    const patch = patches.value.find((item) => item.id === patchId)
    if (!patch || patch.status !== 'pending') return
    const { clean, conflicts } = planMerge(draft.value.document, patch, 'reject')
    if (conflicts.length) {
      runBatch(uid('batch'), `退回冲突：${patch.label}`, () => {
        patch.status = 'conflict'
        patch.merge = { action: 'reject', conflicts }
      })
      return
    }
    runBatch(uid('batch'), `退回：${patch.label}`, () => {
      if (clean.length) {
        draft.value.document = applyMerge(draft.value.document, patch, clean, [])
        draft.value.rev += 1
      }
      patch.status = 'rejected'
      patch.resolvedAt = new Date().toISOString()
    })
  }

  /** 导演在冲突条目上选定一边；全部选定前合入暂停。 */
  function resolveConflict(patchId: string, opIndex: number, choice: 'current' | 'incoming') {
    const patch = patches.value.find((item) => item.id === patchId)
    const conflict = patch?.merge?.conflicts.find((item) => item.opIndex === opIndex)
    if (!patch || !conflict) return
    conflict.choice = choice
    persist()
  }

  /** 全部选定后完成合入：按导演选择写入冲突项，干净项照常应用。 */
  function finalizeMerge(patchId: string) {
    const patch = patches.value.find((item) => item.id === patchId)
    if (!patch || patch.status !== 'conflict' || !patch.merge) return
    const merge = patch.merge
    if (merge.conflicts.some((conflict) => !conflict.choice)) return
    // 以最新草稿重新规划，沿用已做的选择；出现新冲突则继续挂起
    const { clean, conflicts } = planMerge(draft.value.document, patch, merge.action)
    for (const conflict of conflicts) {
      const chosen = merge.conflicts.find(
        (item) => item.opIndex === conflict.opIndex && JSON.stringify(item.incoming) === JSON.stringify(conflict.incoming)
      )
      if (chosen?.choice) conflict.choice = chosen.choice
    }
    if (conflicts.some((conflict) => !conflict.choice)) {
      runBatch(uid('batch'), `冲突更新：${patch.label}`, () => {
        patch.merge = { ...merge, conflicts }
      })
      return
    }
    runBatch(uid('batch'), `完成合入：${patch.label}`, () => {
      draft.value.document = applyMerge(draft.value.document, patch, clean, conflicts)
      draft.value.rev += 1
      patch.status = merge.action === 'accept' ? 'accepted' : 'rejected'
      patch.resolvedAt = new Date().toISOString()
      delete patch.merge
    })
  }

  function acceptAll() {
    const queue = patches.value.filter((item) => item.status === 'pending').reverse()
    if (!queue.length) return
    runBatch(uid('batch'), '全部接受', () => {
      for (const patch of queue) {
        const { clean, conflicts } = planMerge(draft.value.document, patch, 'accept')
        if (conflicts.length) {
          patch.status = 'conflict'
          patch.merge = { action: 'accept', conflicts }
          continue
        }
        if (clean.length) {
          draft.value.document = applyMerge(draft.value.document, patch, clean, [])
          draft.value.rev += 1
        }
        patch.status = 'accepted'
        patch.resolvedAt = new Date().toISOString()
      }
    })
  }

  function undo() {
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(clone(draft.value.document))
    replaceDocument(previous, '撤销上一步修改')
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(clone(draft.value.document))
    replaceDocument(next, '重做修改')
  }

  function freeze(name: string): FrozenVersion {
    const version: FrozenVersion = {
      id: uid('version'),
      name: name.trim() || `制作稿 v${frozen.value.length + 1}`,
      createdAt: new Date().toISOString(),
      document: clone(draft.value.document),
      totalDuration: totalDuration.value
    }
    runBatch(uid('batch'), `冻结 ${version.name}`, () => {
      frozen.value.unshift(version)
    })
    return version
  }

  function makeScript(document: StudioDocument): string {
    const lines = [
      document.title,
      document.subtitle,
      `目标时长：${document.targetDuration} 秒`,
      '='.repeat(48),
      ''
    ]
    document.scenes.forEach((scene, sceneIndex) => {
      lines.push(`${scene.code}｜${scene.title}`)
      lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
      lines.push(`转场：${scene.transition}`)
      lines.push(`场次限额：${scene.durationLimit} 秒｜预计：${durationOfScene(scene)} 秒`)
      lines.push('-'.repeat(34))
      scene.cues.forEach((cue, cueIndex) => {
        const prefix = `${String(cueIndex + 1).padStart(2, '0')} [${durationOfCue(cue).toFixed(1)}s]`
        if (cue.kind === 'dialogue') {
          const role = document.characters.find((character) => character.id === cue.characterId)?.name ?? '未指定角色'
          lines.push(`${prefix} ${role}｜${cue.emotion || '自然'}｜语速 ${cue.rate}`)
          lines.push(`    ${cue.text}`)
        } else if (cue.kind === 'sfx') {
          const effect = document.soundEffects.find((item) => item.id === cue.soundEffectId)
          lines.push(`${prefix} 音效｜${cue.text}`)
          lines.push(`    文件：${effect?.source ?? '缺失引用'}｜${effect?.note ?? '需补齐音效'}`)
        } else {
          lines.push(`${prefix} 转场｜${cue.transition}｜${cue.text}`)
        }
      })
      if (sceneIndex < document.scenes.length - 1) lines.push('')
    })
    return lines.join('\n')
  }

  function downloadVersion(version: FrozenVersion) {
    const blob = new Blob([makeScript(version.document)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${version.document.title}-${version.name}.txt`.replace(/[\\/:*?"<>|]/g, '-')
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function resetSample() {
    commit('恢复示例数据', (document) => {
      const next = clone(sampleDocument)
      Object.assign(document, next)
    })
    selectedSceneId.value = draft.value.document.scenes[0]?.id ?? ''
  }

  return {
    draft,
    patches,
    frozen,
    selectedSceneId,
    selectedCueId,
    selectedScene,
    totalDuration,
    pendingChanges,
    warnings,
    saveState,
    saveError,
    notice,
    durationOfCue,
    durationOfScene,
    updateProject,
    updateScene,
    updateCue,
    addScene,
    deleteScene,
    addCue,
    deleteCue,
    moveCue,
    moveScene,
    acceptChange,
    rejectChange,
    resolveConflict,
    finalizeMerge,
    acceptAll,
    undo,
    redo,
    freeze,
    downloadVersion,
    makeScript,
    resetSample,
    persist,
    retryPersist
  }
}

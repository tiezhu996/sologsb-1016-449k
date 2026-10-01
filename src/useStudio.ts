import { computed, ref } from 'vue'
import { sampleDocument } from './sample'
import { applyOps, diffDocuments, invertOps, opLocation } from './patches'
import { listCheckpoints, loadStore, makeBatchId, makeId, readSnapshot, restoreCheckpoint, transaction } from './storage'
import type {
  Checkpoint,
  ConflictContext,
  ConflictHunk,
  Cue,
  CueKind,
  DraftState,
  FrozenVersion,
  MetaState,
  Patch,
  Role,
  Scene,
  StudioDocument,
  WarningItem
} from './types'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function initialDraft(): DraftState {
  return { document: clone(sampleDocument), revision: 0 }
}

export interface ConflictSessionItem {
  patch: Patch
  /** 待导演选定的冲突操作（索引指向 patch.ops / inverted ops）。 */
  conflicts: Array<{
    opIndex: number
    location: string
    baseText: string
    patchText: string
    liveText: string
  }>
  /** 已选定：take-patch = 采纳补丁方，keep-live = 保留现稿方。 */
  resolutions: Map<number, ConflictHunk['resolution']>
}

export interface ConflictSession {
  context: ConflictContext
  batchId: string
  items: ConflictSessionItem[]
}

export function useStudio() {
  const loaded = loadStore(initialDraft, 'writer')
  const documentRef = ref<StudioDocument>(loaded.draft.document)
  const revision = ref<number>(loaded.draft.revision)
  const patchesRef = ref<Patch[]>(loaded.patches)
  const frozenRef = ref<FrozenVersion[]>(loaded.frozen)
  const metaRef = ref<MetaState>(loaded.meta)
  const checkpoints = ref<Checkpoint[]>(listCheckpoints())
  const saveError = ref('')

  const selectedSceneId = ref(documentRef.value.scenes[0]?.id ?? '')
  const selectedCueId = ref('')
  const saveState = ref<'saved' | 'saving' | 'dirty'>('saved')
  const undoStack = ref<StudioDocument[]>([])
  const redoStack = ref<StudioDocument[]>([])
  let saveTimer: number | undefined

  const conflictSession = ref<ConflictSession | null>(null)
  const sessionDoc = ref<StudioDocument | null>(null)

  const selectedScene = computed(
    () => documentRef.value.scenes.find((scene) => scene.id === selectedSceneId.value) ?? documentRef.value.scenes[0]
  )

  function durationOfCue(cue: Cue): number {
    if (cue.manualDuration !== undefined) return cue.manualDuration
    if (cue.kind === 'sfx') {
      return documentRef.value.soundEffects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
    }
    if (cue.kind === 'transition') return 3
    const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
    const effectiveRate = cue.rate || 1
    return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
  }

  function durationOfScene(scene: Scene): number {
    return Number(scene.cues.reduce((total, cue) => total + durationOfCue(cue), 0).toFixed(1))
  }

  const totalDuration = computed(() =>
    documentRef.value.scenes.reduce((total, scene) => total + durationOfScene(scene), 0)
  )
  const pendingChanges = computed(() => patchesRef.value.filter((item) => item.status === 'pending'))

  const warnings = computed<WarningItem[]>(() => {
    const result: WarningItem[] = []
    for (const scene of documentRef.value.scenes) {
      const actorRoles = new Map<string, string[]>()
      for (const cue of scene.cues) {
        if (cue.kind === 'dialogue' && cue.characterId) {
          const character = documentRef.value.characters.find((item) => item.id === cue.characterId)
          if (character) {
            const roles = actorRoles.get(character.voiceActor) ?? []
            roles.push(character.name)
            actorRoles.set(character.voiceActor, roles)
          }
        }
        if (cue.kind === 'sfx' && cue.soundEffectId && !documentRef.value.soundEffects.some((effect) => effect.id === cue.soundEffectId)) {
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

  /* ------------------------- 持久化（带检查点） ------------------------- */

  function flushSave(
    label: string,
    nextDocument: StudioDocument,
    nextPatches: Patch[],
    nextRevision: number,
    extras?: { frozen?: FrozenVersion[]; meta?: MetaState }
  ): string | undefined {
    const updates: Parameters<typeof transaction>[1] = {
      draft: { document: nextDocument, revision: nextRevision } satisfies DraftState,
      patches: nextPatches,
      meta: extras?.meta ?? metaRef.value
    }
    if (extras?.frozen) updates.frozen = extras.frozen
    const error = transaction(label, updates)
    if (error) {
      // 写入失败：检查点与原稿已保留在本地，内存不切换，重试同一批补丁不会重复生效。
      saveError.value = error
      saveState.value = 'dirty'
      checkpoints.value = listCheckpoints()
      return error
    }
    saveError.value = ''
    saveState.value = 'saved'
    checkpoints.value = listCheckpoints()
    return undefined
  }

  function persist() {
    window.clearTimeout(saveTimer)
    const error = transaction('手动保存工作稿', {
      draft: { document: documentRef.value, revision: revision.value } satisfies DraftState,
      patches: patchesRef.value,
      frozen: frozenRef.value,
      meta: metaRef.value
    })
    if (error) {
      saveError.value = error
      saveState.value = 'dirty'
      checkpoints.value = listCheckpoints()
    } else {
      saveError.value = ''
      saveState.value = 'saved'
    }
  }

  /**
   * 一次本地编辑：草稿直接更新，并把「基准稿 → 现稿」diff 成补丁放入待确认区。
   * 补丁记住 baseRevision；落库失败时内存与磁盘都保持原状。
   */
  function commit(label: string, mutator: (document: StudioDocument) => void, note = '') {
    const before = clone(documentRef.value)
    const draft = clone(documentRef.value)
    mutator(draft)
    if (diffDocuments(before, draft).length === 0) return

    const patch: Patch = {
      id: makeId('patch'),
      label,
      note,
      author: metaRef.value.role,
      createdAt: new Date().toISOString(),
      status: 'pending',
      baseRevision: revision.value,
      ops: diffDocuments(before, draft),
      hunks: []
    }
    const nextPatches = trimPatches([patch, ...patchesRef.value])
    const nextRevision = revision.value + 1
    const holdRevision = revision.value
    const holdRedo = redoStack.value
    const holdUndoLength = undoStack.value.length
    revision.value = nextRevision
    documentRef.value = draft
    redoStack.value = []
    undoStack.value.push(before)
    if (undoStack.value.length > 60) undoStack.value.shift()

    // 编辑事务只覆盖草稿与补丁两个分区；冻结库保持独立，不参与回滚。
    const error = flushSave(label, draft, nextPatches, nextRevision)
    if (error) {
      revision.value = holdRevision
      documentRef.value = before
      undoStack.value = undoStack.value.slice(0, holdUndoLength)
      redoStack.value = holdRedo
      return
    }
    patchesRef.value = nextPatches
    saveState.value = 'saving'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      saveState.value = 'saved'
    }, 250)
  }

  function trimPatches(all: Patch[]): Patch[] {
    const pending = all.filter((item) => item.status === 'pending')
    const decided = all.filter((item) => item.status !== 'pending')
    return [...pending, ...decided.slice(0, 60)]
  }

  /** 仅供撤销/重做：不产生新补丁，只交换草稿。 */
  function swapTo(label: string, next: StudioDocument) {
    const before = clone(documentRef.value)
    const hold = revision.value
    revision.value = hold + 1
    documentRef.value = next
    const error = flushSave(label, next, patchesRef.value, hold + 1)
    if (error) {
      revision.value = hold
      documentRef.value = before
    }
  }

  /* ------------------------- 编辑动作 ------------------------- */

  function updateProject(field: 'title' | 'subtitle' | 'targetDuration', value: string | number) {
    commit(`更新项目${field === 'title' ? '标题' : field === 'subtitle' ? '副标题' : '目标时长'}`, (document) => {
      if (field === 'targetDuration') document.targetDuration = Number(value)
      else document[field] = String(value)
    })
  }

  function updateScene(sceneId: string, field: keyof Scene, value: string | number) {
    commit(`更新 ${documentRef.value.scenes.find((scene) => scene.id === sceneId)?.code ?? '场次'} ${field}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (field === 'durationLimit') scene.durationLimit = Number(value)
      else if (field === 'code' || field === 'title' || field === 'location' || field === 'timeOfDay' || field === 'transition') {
        scene[field] = String(value)
      }
    })
  }

  function updateCue(cueId: string, field: keyof Cue, value: string | number | undefined) {
    commit(`修改台词 ${documentRef.value.scenes.flatMap((scene) => scene.cues).find((cue) => cue.id === cueId)?.text.slice(0, 12) ?? ''}`, (document) => {
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
    const nextNumber = documentRef.value.scenes.length + 1
    const id = makeId('scene')
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
    if (documentRef.value.scenes.length <= 1) return
    const scene = documentRef.value.scenes.find((item) => item.id === sceneId)
    commit(`删除场次 ${scene?.code ?? ''}`, (document) => {
      document.scenes = document.scenes.filter((item) => item.id !== sceneId)
    })
    selectedSceneId.value = documentRef.value.scenes[0].id
  }

  function addCue(kind: CueKind, sceneId = selectedSceneId.value) {
    const id = makeId('cue')
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
    const index = documentRef.value.scenes.findIndex((scene) => scene.id === sceneId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= documentRef.value.scenes.length) return
    commit('调整场次顺序', (document) => {
      const [scene] = document.scenes.splice(index, 1)
      document.scenes.splice(target, 0, scene)
    })
  }

  function undo() {
    if (conflictSession.value) return
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(clone(documentRef.value))
    swapTo('撤销上一步修改', previous)
  }

  function redo() {
    if (conflictSession.value) return
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(clone(documentRef.value))
    swapTo('重做修改', next)
  }

  function resetSample() {
    commit('恢复示例数据', (document) => {
      Object.assign(document, clone(sampleDocument))
    })
    selectedSceneId.value = documentRef.value.scenes[0]?.id ?? ''
  }

  /* ------------------------- 补丁接受 / 退回（三方合并） ------------------------- */

  function opsForPatch(patch: Patch, context: ConflictContext) {
    return context === 'accept' ? patch.ops : invertOps(patch.ops)
  }

  /** 对单条补丁发起接受/退回；若有同条内容被两边同时改动，挂起冲突等待导演选定。 */
  function beginDecision(patchId: string, context: ConflictContext) {
    if (conflictSession.value) return
    const patch = patchesRef.value.find((item) => item.id === patchId)
    if (!patch || patch.status !== 'pending') return
    const trial = clone(documentRef.value)
    const ops = opsForPatch(patch, context)
    const result = applyOps(trial, ops, context, new Map())
    if (result.conflicts.length) {
      conflictSession.value = {
        context,
        batchId: makeBatchId(),
        items: [
          {
            patch,
            conflicts: result.conflicts.map((conflict) => ({ ...conflict })),
            resolutions: new Map()
          }
        ]
      }
      sessionDoc.value = trial
      return
    }
    commitDecision([{ patch, doc: trial, changed: result.changed }], context, makeBatchId())
  }

  /**
   * 全部接受：按补丁产生顺序逐条合入；任一条冲突则挂起，选定后继续，其余干净补丁照常合入。
   * 冲突补丁只在克隆稿上探测冲突，不能把未选定的操作提前写进共享工作稿。
   */
  function acceptAll() {
    if (conflictSession.value) return
    const queue = pendingChanges.value.slice().reverse()
    if (!queue.length) return
    const batchId = makeBatchId()
    const applied: Array<{ patch: Patch; doc: StudioDocument; changed: boolean }> = []
    const blocked: ConflictSessionItem[] = []
    let doc = clone(documentRef.value)
    for (const patch of queue) {
      const probe = applyOps(clone(doc), patch.ops, 'accept', new Map())
      if (probe.conflicts.length) {
        blocked.push({
          patch,
          conflicts: probe.conflicts.map((conflict) => ({ ...conflict })),
          resolutions: new Map()
        })
        continue
      }
      // 干净补丁正式合入共享工作稿，供后续补丁基于最新状态判定。
      const result = applyOps(doc, patch.ops, 'accept', new Map())
      applied.push({ patch, doc: clone(doc), changed: result.changed })
    }
    if (blocked.length) {
      conflictSession.value = { context: 'accept', batchId, items: blocked }
      sessionDoc.value = clone(documentRef.value)
      return
    }
    commitDecision(applied, 'accept', batchId)
  }

  function resolveConflict(itemIndex: number, opIndex: number, resolution: ConflictHunk['resolution']) {
    const session = conflictSession.value
    if (!session) return
    const item = session.items[itemIndex]
    if (!item) return
    item.resolutions.set(opIndex, resolution)
  }

  const sessionResolvedAll = computed(() => {
    const session = conflictSession.value
    if (!session) return false
    return session.items.every((item) => item.conflicts.every((conflict) => item.resolutions.has(conflict.opIndex)))
  })

  /** 导演逐项选定后确认：以选定结果在试演稿上回放冲突操作，然后整批一次落库。 */
  function confirmConflictSession() {
    const session = conflictSession.value
    if (!session || !sessionDoc.value) return
    if (!sessionResolvedAll.value) return

    let doc = clone(documentRef.value)
    const applied: Array<{ patch: Patch; doc: StudioDocument; changed: boolean }> = []

    if (session.context === 'reject') {
      const item = session.items[0]
      const result = applyOps(doc, invertOps(item.patch.ops), 'reject', item.resolutions)
      if (result.conflicts.length) return
      applied.push({ patch: item.patch, doc: clone(doc), changed: result.changed })
    } else {
      // 全部接受：非冲突补丁先合，再按顺序合入已解决冲突的补丁。
      const blockedIds = new Set(session.items.map((item) => item.patch.id))
      const queue = pendingChanges.value.slice().reverse()
      for (const patch of queue) {
        if (blockedIds.has(patch.id)) continue
        const result = applyOps(doc, patch.ops, 'accept', new Map())
        if (!result.conflicts.length && result.changed) applied.push({ patch, doc: clone(doc), changed: result.changed })
      }
      for (const item of session.items) {
        const result = applyOps(doc, item.patch.ops, 'accept', item.resolutions)
        if (result.conflicts.length) return
        applied.push({ patch: item.patch, doc: clone(doc), changed: result.changed })
      }
    }

    commitDecision(applied, session.context, session.batchId)
    conflictSession.value = null
    sessionDoc.value = null
  }

  function cancelConflictSession() {
    conflictSession.value = null
    sessionDoc.value = null
  }

  /**
   * 整批落库：一次事务同时更新草稿、补丁状态与稿次。
   * 重试同一批次时，已 accepted/rejected 的补丁直接跳过，因此不会重复生效。
   */
  function commitDecision(
    applied: Array<{ patch: Patch; doc: StudioDocument; changed: boolean }>,
    context: ConflictContext,
    batchId: string
  ) {
    const finalDoc = applied.length ? applied[applied.length - 1].doc : clone(documentRef.value)
    const changedCount = applied.filter((item) => item.changed).length

    const nextPatches = clone(patchesRef.value)
    const decidedAt = new Date().toISOString()
    const hunksByPatch = new Map<string, ConflictHunk[]>()
    conflictSession.value?.items.forEach((item) => {
      const hunks: ConflictHunk[] = []
      item.resolutions.forEach((resolution, opIndex) => {
        const conflict = item.conflicts.find((entry) => entry.opIndex === opIndex)
        if (!conflict) return
        hunks.push({
          id: makeId('hunk'),
          opIndex,
          context,
          resolution,
          baseText: conflict.baseText,
          patchText: conflict.patchText,
          liveText: conflict.liveText
        })
      })
      if (hunks.length) hunksByPatch.set(item.patch.id, hunks)
    })

    const nextRevision = revision.value + changedCount
    for (const { patch } of applied) {
      const target = nextPatches.find((item) => item.id === patch.id)
      if (!target || target.status !== 'pending') continue
      target.status = context === 'accept' ? 'accepted' : 'rejected'
      target.decidedAt = decidedAt
      target.batchId = batchId
      target.appliedRevision = nextRevision
      const hunks = hunksByPatch.get(patch.id)
      if (hunks) target.hunks = hunks
    }

    const holdDoc = documentRef.value
    const holdRevision = revision.value
    const holdPatches = patchesRef.value
    revision.value = nextRevision
    documentRef.value = finalDoc
    const error = flushSave(context === 'accept' ? '接受补丁' : '退回补丁', finalDoc, trimPatches(nextPatches), nextRevision)
    if (error) {
      revision.value = holdRevision
      documentRef.value = holdDoc
      patchesRef.value = holdPatches
      return
    }
    patchesRef.value = trimPatches(nextPatches)
    if (context === 'reject') {
      // 退回不进入撤销栈（它本身就是导演决策）；清空重做栈避免跨越决策。
      redoStack.value = []
    }
  }

  function acceptChange(patchId: string) {
    beginDecision(patchId, 'accept')
  }

  function rejectChange(patchId: string) {
    beginDecision(patchId, 'reject')
  }

  /* ------------------------- 角色 / 通知 / 检查点 ------------------------- */

  function setRole(role: Role) {
    const nextMeta = { ...metaRef.value, role }
    const error = transaction('切换整理身份', {
      draft: { document: documentRef.value, revision: revision.value } satisfies DraftState,
      patches: patchesRef.value,
      frozen: frozenRef.value,
      meta: nextMeta
    })
    if (!error) metaRef.value = nextMeta
    else saveError.value = error
  }

  function dismissNotice() {
    const nextMeta = { ...metaRef.value, notice: undefined }
    metaRef.value = nextMeta
    persist()
  }

  function dismissSaveError() {
    saveError.value = ''
  }

  function recoverCheckpoint(checkpointId: string) {
    const error = restoreCheckpoint(checkpointId)
    if (error) {
      saveError.value = error
      return
    }
    const snapshot = readSnapshot(metaRef.value.role)
    if (snapshot) {
      documentRef.value = snapshot.draft.document
      revision.value = snapshot.draft.revision
      patchesRef.value = snapshot.patches
      frozenRef.value = snapshot.frozen
      metaRef.value = snapshot.meta
      checkpoints.value = listCheckpoints()
      selectedSceneId.value = documentRef.value.scenes[0]?.id ?? ''
      undoStack.value = []
      redoStack.value = []
    }
  }

  function refreshCheckpoints() {
    checkpoints.value = listCheckpoints()
  }

  /* ------------------------- 冻结 / 导出 ------------------------- */

  function freeze(name: string): FrozenVersion | undefined {
    const version: FrozenVersion = {
      id: makeId('version'),
      name: name.trim() || `制作稿 v${frozenRef.value.length + 1}`,
      createdAt: new Date().toISOString(),
      document: clone(documentRef.value),
      totalDuration: totalDuration.value
    }
    const nextFrozen = [version, ...frozenRef.value]
    const hold = frozenRef.value
    frozenRef.value = nextFrozen
    const error = flushSave(`冻结制作稿 ${version.name}`, documentRef.value, patchesRef.value, revision.value, { frozen: nextFrozen })
    if (error) {
      frozenRef.value = hold
      return undefined
    }
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

  /** 给待确认卡片展示：该补丁触及的台词/音效提示位置。 */
  function patchLocations(patch: Patch): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const op of patch.ops.slice(0, 6)) {
      const text = opLocation(documentRef.value, op)
      if (!seen.has(text)) {
        seen.add(text)
        result.push(text)
      }
    }
    return result
  }

  return {
    // 兼容 App.vue 使用的 state 形状
    state: computed(() => ({
      document: documentRef.value,
      pending: patchesRef.value,
      frozen: frozenRef.value,
      updatedAt: new Date().toISOString()
    })),
    revision,
    meta: metaRef,
    checkpoints,
    saveError,
    conflictSession,
    sessionResolvedAll,
    selectedSceneId,
    selectedCueId,
    selectedScene,
    totalDuration,
    pendingChanges,
    warnings,
    saveState,
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
    acceptAll,
    resolveConflict,
    confirmConflictSession,
    cancelConflictSession,
    setRole,
    dismissNotice,
    dismissSaveError,
    recoverCheckpoint,
    refreshCheckpoints,
    undo,
    redo,
    freeze,
    downloadVersion,
    makeScript,
    patchLocations,
    resetSample,
    persist
  }
}

export type Studio = ReturnType<typeof useStudio>

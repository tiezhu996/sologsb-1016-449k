import type {
  AddOp,
  Cue,
  ConflictContext,
  ConflictResolution,
  FieldValue,
  PatchOp,
  RemoveOp,
  Scene,
  SetOp,
  StudioDocument
} from './types'

/**
 * 补丁引擎：把整份前后稿压缩成按 id 定位的操作序列（补丁），
 * 接受/退回时以「基准值 → 补丁值 → 现稿值」做三方合并，
 * 同一条内容被两边同时改动时产出并列冲突，而不是直接覆盖。
 */

const PROJECT_FIELDS = ['title', 'subtitle', 'targetDuration'] as const
const SCENE_FIELDS = ['code', 'title', 'location', 'timeOfDay', 'transition', 'durationLimit'] as const
const CUE_FIELDS = ['kind', 'characterId', 'text', 'emotion', 'rate', 'soundEffectId', 'transition', 'manualDuration'] as const
const CHARACTER_FIELDS = ['name', 'voiceActor', 'color'] as const
const SFX_FIELDS = ['name', 'duration', 'source', 'note'] as const

const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  subtitle: '副标题',
  targetDuration: '目标时长',
  code: '场次号',
  location: '空间',
  timeOfDay: '时间',
  transition: '转场',
  durationLimit: '场次限额',
  kind: '类型',
  characterId: '角色',
  text: '文本',
  emotion: '情绪',
  rate: '语速',
  soundEffectId: '音效',
  manualDuration: '手动时长',
  name: '名称',
  voiceActor: '配音演员',
  color: '标识色',
  duration: '时长',
  source: '素材路径',
  note: '备注'
}

const KIND_LABELS: Record<string, string> = { dialogue: '台词', sfx: '音效', transition: '转场' }

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false
  return ka.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

const scalarEqual = (a: FieldValue, b: FieldValue) => (a == null && b == null) || a === b

interface ListDiff<T extends { id: string }> {
  removed: { item: T; index: number }[]
  added: { item: T; index: number }[]
  moved: { id: string; from: number; to: number }[]
}

/** 有序集合 diff：先按 id 找增删，再在「删除后、插入后」的中间序列上推导移动。 */
function diffOrderedList<T extends { id: string }>(before: T[], after: T[]): ListDiff<T> {
  const afterIds = after.map((item) => item.id)
  const afterIndex = new Map(after.map((item, index) => [item.id, index]))
  const beforeMap = new Map(before.map((item) => [item.id, item]))

  const removed: ListDiff<T>['removed'] = []
  before.forEach((item, index) => {
    if (!afterIndex.has(item.id)) removed.push({ item, index })
  })
  const added: ListDiff<T>['added'] = []
  after.forEach((item, index) => {
    if (!beforeMap.has(item.id)) added.push({ item, index })
  })

  // 中间序列：旧序剔除删除项，再按最终下标升序插入新增项。
  const intermediate = before.filter((item) => afterIndex.has(item.id)).map((item) => item.id)
  ;[...added].sort((a, b) => a.index - b.index).forEach(({ item, index }) => {
    intermediate.splice(Math.min(index, intermediate.length), 0, item.id)
  })

  const moved: ListDiff<T>['moved'] = []
  for (let i = 0; i < intermediate.length; i += 1) {
    if (intermediate[i] !== afterIds[i]) {
      const j = intermediate.indexOf(afterIds[i], i)
      if (j > i) {
        moved.push({ id: afterIds[i], from: j, to: i })
        const [id] = intermediate.splice(j, 1)
        intermediate.splice(i, 0, id)
      }
    }
  }
  return { removed, added, moved }
}

function fieldSets<T extends object>(
  before: T,
  after: T,
  fields: readonly string[],
  make: (field: string, value: FieldValue, oldValue: FieldValue) => SetOp
): SetOp[] {
  const ops: SetOp[] = []
  for (const field of fields) {
    const oldValue = (before as Record<string, FieldValue>)[field]
    const value = (after as Record<string, FieldValue>)[field]
    if (!scalarEqual(oldValue, value)) ops.push(make(field, value, oldValue))
  }
  return ops
}

/** 把两份完整稿 diff 成可回放、可反向、可三方合并的操作序列。 */
export function diffDocuments(before: StudioDocument, after: StudioDocument): PatchOp[] {
  const ops: PatchOp[] = []

  ops.push(
    ...fieldSets(before, after, PROJECT_FIELDS, (field, value, oldValue) => ({
      type: 'set',
      target: 'project',
      field,
      value,
      oldValue
    }))
  )

  const charDiff = diffOrderedList(before.characters, after.characters)
  for (const { item, index } of [...charDiff.removed].sort((a, b) => b.index - a.index)) {
    ops.push({ type: 'remove', target: 'character', index, sceneId: '', itemId: item.id, character: item })
  }
  for (const { item, index } of [...charDiff.added].sort((a, b) => a.index - b.index)) {
    ops.push({ type: 'add', target: 'character', index, itemId: item.id, character: item })
  }
  for (const move of charDiff.moved) ops.push({ type: 'move', target: 'character', id: move.id, from: move.from, to: move.to })
  for (const character of after.characters) {
    const old = before.characters.find((item) => item.id === character.id)
    if (!old) continue
    ops.push(
      ...fieldSets(old, character, CHARACTER_FIELDS, (field, value, oldValue) => ({
        type: 'set',
        target: 'character',
        field,
        value,
        oldValue,
        itemId: character.id
      }))
    )
  }

  const sfxDiff = diffOrderedList(before.soundEffects, after.soundEffects)
  for (const { item, index } of [...sfxDiff.removed].sort((a, b) => b.index - a.index)) {
    ops.push({ type: 'remove', target: 'soundEffect', index, sceneId: '', itemId: item.id, soundEffect: item })
  }
  for (const { item, index } of [...sfxDiff.added].sort((a, b) => a.index - b.index)) {
    ops.push({ type: 'add', target: 'soundEffect', index, itemId: item.id, soundEffect: item })
  }
  for (const move of sfxDiff.moved) ops.push({ type: 'move', target: 'soundEffect', id: move.id, from: move.from, to: move.to })
  for (const effect of after.soundEffects) {
    const old = before.soundEffects.find((item) => item.id === effect.id)
    if (!old) continue
    ops.push(
      ...fieldSets(old, effect, SFX_FIELDS, (field, value, oldValue) => ({
        type: 'set',
        target: 'soundEffect',
        field,
        value,
        oldValue,
        itemId: effect.id
      }))
    )
  }

  const sceneDiff = diffOrderedList(before.scenes, after.scenes)
  for (const { item, index } of [...sceneDiff.removed].sort((a, b) => b.index - a.index)) {
    ops.push({ type: 'remove', target: 'scene', index, sceneId: item.id, scene: item })
  }
  for (const { item, index } of [...sceneDiff.added].sort((a, b) => a.index - b.index)) {
    ops.push({ type: 'add', target: 'scene', index, scene: item })
  }
  for (const move of sceneDiff.moved) ops.push({ type: 'move', target: 'scene', id: move.id, from: move.from, to: move.to })

  for (const scene of after.scenes) {
    const oldScene = before.scenes.find((item) => item.id === scene.id)
    if (!oldScene) continue
    ops.push(
      ...fieldSets(oldScene, scene, SCENE_FIELDS, (field, value, oldValue) => ({
        type: 'set',
        target: 'scene',
        field,
        value,
        oldValue,
        sceneId: scene.id
      }))
    )

    const cueDiff = diffOrderedList(oldScene.cues, scene.cues)
    for (const { item, index } of [...cueDiff.removed].sort((a, b) => b.index - a.index)) {
      ops.push({ type: 'remove', target: 'cue', index, sceneId: scene.id, cueId: item.id, cue: item })
    }
    for (const { item, index } of [...cueDiff.added].sort((a, b) => a.index - b.index)) {
      ops.push({ type: 'add', target: 'cue', index, sceneId: scene.id, cue: item })
    }
    for (const move of cueDiff.moved) {
      ops.push({ type: 'move', target: 'cue', id: move.id, from: move.from, to: move.to, sceneId: scene.id })
    }
    for (const cue of scene.cues) {
      const oldCue = oldScene.cues.find((item) => item.id === cue.id)
      if (!oldCue) continue
      ops.push(
        ...fieldSets(oldCue, cue, CUE_FIELDS, (field, value, oldValue) => ({
          type: 'set',
          target: 'cue',
          field,
          value,
          oldValue,
          sceneId: scene.id,
          cueId: cue.id
        }))
      )
    }
  }

  return ops
}

/** 反向操作序列：退回补丁时回放它即可恢复基准稿。 */
export function invertOps(ops: PatchOp[]): PatchOp[] {
  const inverted: PatchOp[] = []
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i]
    if (op.type === 'set') {
      inverted.push({ ...op, value: op.oldValue, oldValue: op.value })
    } else if (op.type === 'move') {
      inverted.push({ ...op, from: op.to, to: op.from })
    } else if (op.type === 'add') {
      inverted.push({
        type: 'remove',
        target: op.target,
        index: op.index,
        sceneId: op.sceneId ?? op.scene?.id ?? '',
        cueId: op.cue?.id ?? op.cueId,
        itemId: op.itemId,
        scene: op.scene,
        cue: op.cue,
        character: op.character,
        soundEffect: op.soundEffect
      })
    } else {
      inverted.push({
        type: 'add',
        target: op.target,
        index: op.index,
        sceneId: op.sceneId || undefined,
        cueId: op.cue?.id ?? op.cueId,
        itemId: op.itemId,
        scene: op.scene,
        cue: op.cue,
        character: op.character,
        soundEffect: op.soundEffect
      })
    }
  }
  return inverted
}

/* ------------------------- 三方合并引擎 ------------------------- */

export interface ApplyConflict {
  opIndex: number
  location: string
  baseText: string
  patchText: string
  liveText: string
}

export interface ApplyResult {
  conflicts: ApplyConflict[]
  changed: boolean
}

type ResolutionMap = Map<number, ConflictResolution>

function findCue(doc: StudioDocument, cueId: string | undefined): { scene: Scene; cue: Cue; index: number } | undefined {
  if (!cueId) return undefined
  for (const scene of doc.scenes) {
    const index = scene.cues.findIndex((cue) => cue.id === cueId)
    if (index >= 0) return { scene, cue: scene.cues[index], index }
  }
  return undefined
}

function listFor(doc: StudioDocument, op: PatchOp): { id: string }[] | undefined {
  if (op.target === 'scene') return doc.scenes
  if (op.target === 'character') return doc.characters
  if (op.target === 'soundEffect') return doc.soundEffects
  if (op.target === 'cue') return doc.scenes.find((scene) => scene.id === op.sceneId)?.cues
  return undefined
}

function entityIdOf(op: AddOp | RemoveOp): string {
  return op.scene?.id ?? op.cue?.id ?? op.character?.id ?? op.soundEffect?.id ?? op.cueId ?? op.itemId ?? ''
}

function snapshotOf(op: AddOp | RemoveOp): { id: string } | undefined {
  return op.scene ?? op.cue ?? op.character ?? op.soundEffect
}

function formatValue(value: FieldValue): string {
  if (value === undefined || value === '') return '（清空）'
  return String(value)
}

function describeEntity(doc: StudioDocument, target: PatchOp['target'], entity: unknown): string {
  if (target === 'scene') {
    const scene = entity as Scene
    return `场次 ${scene.code}「${scene.title}」含 ${scene.cues.length} 条提示`
  }
  if (target === 'cue') {
    const cue = entity as Cue
    if (cue.kind === 'dialogue') {
      const role = doc.characters.find((item) => item.id === cue.characterId)?.name ?? '未指定角色'
      return `台词 ${role}：${cue.text || '（空）'}`
    }
    if (cue.kind === 'sfx') return `音效提示：${cue.text || '（空）'}`
    return `转场 ${cue.transition || ''}：${cue.text || '（空）'}`
  }
  if (target === 'character') {
    const character = entity as StudioDocument['characters'][number]
    return `角色 ${character.name}（配音 ${character.voiceActor}）`
  }
  const effect = entity as StudioDocument['soundEffects'][number]
  return `音效素材 ${effect.name}（${effect.duration}s）`
}

export function opLocation(doc: StudioDocument, op: PatchOp): string {
  const itemId = op.type === 'move' ? op.id : (op as AddOp | RemoveOp | SetOp).itemId
  if (op.target === 'project') return `项目设定 · ${FIELD_LABELS[op.field] ?? op.field}`
  if (op.target === 'character') {
    const name = itemId ? doc.characters.find((item) => item.id === itemId)?.name : undefined
    return op.type === 'set' ? `角色库 · ${name ?? '角色'} · ${FIELD_LABELS[op.field] ?? op.field}` : `角色库 · ${name ?? '角色'}`
  }
  if (op.target === 'soundEffect') {
    const name = itemId ? doc.soundEffects.find((item) => item.id === itemId)?.name : undefined
    return op.type === 'set' ? `音效库 · ${name ?? '音效'} · ${FIELD_LABELS[op.field] ?? op.field}` : `音效库 · ${name ?? '音效'}`
  }
  if (op.target === 'scene') {
    const sceneId = op.type === 'set' ? op.sceneId : op.type === 'move' ? op.id : (op.scene?.id ?? op.sceneId)
    const code = doc.scenes.find((item) => item.id === sceneId)?.code ?? '场次'
    return op.type === 'set' ? `场次 ${code} · ${FIELD_LABELS[op.field] ?? op.field}` : `场次 ${code}`
  }
  // cue
  const cueId = op.type === 'set' ? op.cueId : op.type === 'move' ? op.id : (op.cue?.id ?? op.cueId)
  const found = findCue(doc, cueId)
  const code = doc.scenes.find((scene) => scene.id === (op.type === 'set' ? op.sceneId : op.sceneId))?.code ?? found?.scene.code ?? '场次'
  if (op.type === 'set') {
    return `场次 ${code} / ${KIND_LABELS[found?.cue.kind ?? 'dialogue']}「${(found?.cue.text ?? '').slice(0, 12)}」· ${FIELD_LABELS[op.field] ?? op.field}`
  }
  return `场次 ${code} / ${KIND_LABELS[found?.cue.kind ?? 'dialogue']}「${(found?.cue.text ?? '').slice(0, 12)}」`
}

/**
 * 在工作稿上回放操作（接受 = 正向 ops；退回 = invertOps(ops)）。
 * 干净合入直接落值；基准值与现稿不一致时挂起为冲突，等待导演选定。
 * 全部冲突解决后再次调用即可合入；同一批补丁重试不会重复生效。
 */
export function applyOps(
  doc: StudioDocument,
  ops: PatchOp[],
  context: ConflictContext,
  resolutions: ResolutionMap
): ApplyResult {
  const conflicts: ApplyConflict[] = []
  let changed = false

  ops.forEach((op, opIndex) => {
    if (op.type === 'set') {
      let entity: Record<string, FieldValue> | undefined
      if (op.target === 'project') entity = doc as unknown as Record<string, FieldValue>
      else if (op.target === 'scene') entity = doc.scenes.find((item) => item.id === op.sceneId) as unknown as Record<string, FieldValue> | undefined
      else if (op.target === 'cue') entity = findCue(doc, op.cueId)?.cue as unknown as Record<string, FieldValue> | undefined
      else if (op.target === 'character') entity = doc.characters.find((item) => item.id === op.itemId) as unknown as Record<string, FieldValue> | undefined
      else entity = doc.soundEffects.find((item) => item.id === op.itemId) as unknown as Record<string, FieldValue> | undefined
      if (!entity) return
      const live = entity[op.field]
      if (scalarEqual(live, op.value)) return
      if (scalarEqual(live, op.oldValue)) {
        entity[op.field] = op.value
        changed = true
        return
      }
      const resolution = resolutions.get(opIndex)
      if (resolution === 'take-patch') {
        entity[op.field] = op.value
        changed = true
      } else if (resolution === 'keep-live') {
        // 导演保留现稿，该操作不生效。
      } else {
        conflicts.push({
          opIndex,
          location: opLocation(doc, op),
          baseText: formatValue(op.oldValue),
          patchText: formatValue(op.value),
          liveText: formatValue(live)
        })
      }
      return
    }

    if (op.type === 'add') {
      const list = listFor(doc, op)
      if (!list) return
      const snapshot = snapshotOf(op)
      const id = entityIdOf(op)
      const existingIndex = list.findIndex((item) => item.id === id)
      if (existingIndex >= 0) {
        const existing = list[existingIndex]
        if (snapshot && deepEqual(existing, snapshot)) return
        const resolution = resolutions.get(opIndex)
        if (resolution === 'take-patch' && snapshot) {
          list.splice(existingIndex, 1, snapshot)
          changed = true
        } else if (resolution === 'keep-live') {
          // 保留现稿条目。
        } else {
          conflicts.push({
            opIndex,
            location: opLocation(doc, op),
            baseText: '（不存在）',
            patchText: snapshot ? describeEntity(doc, op.target, snapshot) : '新增条目',
            liveText: describeEntity(doc, op.target, existing)
          })
        }
        return
      }
      if (!snapshot) return
      list.splice(Math.min(op.index, list.length), 0, snapshot)
      changed = true
      return
    }

    if (op.type === 'remove') {
      const list = listFor(doc, op)
      if (!list) return
      const id = entityIdOf(op)
      const index = list.findIndex((item) => item.id === id)
      if (index < 0) return
      const existing = list[index]
      const snapshot = snapshotOf(op)
      if (snapshot && deepEqual(existing, snapshot)) {
        list.splice(index, 1)
        changed = true
        return
      }
      const resolution = resolutions.get(opIndex)
      if (resolution === 'take-patch') {
        list.splice(index, 1)
        changed = true
      } else if (resolution === 'keep-live') {
        // 保留现稿条目。
      } else {
        conflicts.push({
          opIndex,
          location: opLocation(doc, op),
          baseText: snapshot ? describeEntity(doc, op.target, snapshot) : '原稿条目',
          patchText: '删除该条目',
          liveText: describeEntity(doc, op.target, existing)
        })
      }
      return
    }

    // move：仅调整顺序，按补丁目标位置回放；条目缺失则跳过，不产生冲突。
    const list = listFor(doc, op)
    if (!list) return
    const from = list.findIndex((item) => item.id === op.id)
    if (from < 0) return
    const to = Math.max(0, Math.min(op.to, list.length - 1))
    if (from === to) return
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    changed = true
  })

  // context 仅用于调用方给冲突打标，引擎内两种方向逻辑一致。
  void context
  return { conflicts, changed }
}

import type { Cue, OpConflict, Patch, PatchOp, Scene, SceneMeta, StudioDocument } from './types'

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function sceneMeta(scene: Scene): SceneMeta {
  const { cues: _cues, ...meta } = scene
  return clone(meta)
}

/**
 * 把两份整稿的差异拆成逐条操作：项目字段、场次元信息、场次顺序、
 * 以及每一场里的台词 / 音效提示增删改与顺序。旧快照迁移也走这里。
 */
export function diffDocuments(before: StudioDocument, after: StudioDocument): PatchOp[] {
  const ops: PatchOp[] = []

  for (const field of ['title', 'subtitle', 'targetDuration'] as const) {
    if (!equal(before[field], after[field])) {
      ops.push({ kind: 'project-set', field, before: before[field], after: after[field] })
    }
  }

  const beforeScenes = new Map(before.scenes.map((scene) => [scene.id, scene]))
  const afterScenes = new Map(after.scenes.map((scene) => [scene.id, scene]))

  for (const scene of before.scenes) {
    if (!afterScenes.has(scene.id)) {
      // 先记场次删除，再逐条记台词 / 音效删除：反向应用时按序恢复
      ops.push({ kind: 'scene-set', sceneId: scene.id, before: sceneMeta(scene), after: null })
      scene.cues.forEach((cue, index) => {
        ops.push({ kind: 'cue-set', sceneId: scene.id, cueId: cue.id, index, before: clone(cue), after: null })
      })
    }
  }
  for (const scene of after.scenes) {
    const previous = beforeScenes.get(scene.id)
    if (!previous) {
      ops.push({ kind: 'scene-set', sceneId: scene.id, before: null, after: sceneMeta(scene) })
      scene.cues.forEach((cue, index) => {
        ops.push({ kind: 'cue-set', sceneId: scene.id, cueId: cue.id, index, before: null, after: clone(cue) })
      })
      continue
    }
    if (!equal(sceneMeta(previous), sceneMeta(scene))) {
      ops.push({ kind: 'scene-set', sceneId: scene.id, before: sceneMeta(previous), after: sceneMeta(scene) })
    }
    diffCues(scene, previous, ops)
  }

  const beforeOrder = before.scenes.map((scene) => scene.id)
  const afterOrder = after.scenes.map((scene) => scene.id)
  if (!equal(beforeOrder, afterOrder)) ops.push({ kind: 'scene-order', before: beforeOrder, after: afterOrder })

  return ops
}

function diffCues(scene: Scene, previous: Scene, ops: PatchOp[]) {
  const beforeCues = new Map(previous.cues.map((cue) => [cue.id, cue]))
  const afterCues = new Map(scene.cues.map((cue) => [cue.id, cue]))

  previous.cues.forEach((cue, index) => {
    if (!afterCues.has(cue.id)) {
      ops.push({ kind: 'cue-set', sceneId: scene.id, cueId: cue.id, index, before: clone(cue), after: null })
    }
  })
  scene.cues.forEach((cue, index) => {
    const old = beforeCues.get(cue.id)
    if (!old) ops.push({ kind: 'cue-set', sceneId: scene.id, cueId: cue.id, index, before: null, after: clone(cue) })
    else if (!equal(old, cue)) ops.push({ kind: 'cue-set', sceneId: scene.id, cueId: cue.id, index, before: clone(old), after: clone(cue) })
  })

  const beforeOrder = previous.cues.map((cue) => cue.id)
  const afterOrder = scene.cues.map((cue) => cue.id)
  if (!equal(beforeOrder, afterOrder)) ops.push({ kind: 'cue-order', sceneId: scene.id, before: beforeOrder, after: afterOrder })
}

/* ---- 值读取：返回操作目标在草稿里的当前值 ---- */

function findScene(document: StudioDocument, sceneId: string) {
  return document.scenes.find((scene) => scene.id === sceneId)
}

function findCue(document: StudioDocument, cueId: string): Cue | undefined {
  for (const scene of document.scenes) {
    const cue = scene.cues.find((item) => item.id === cueId)
    if (cue) return cue
  }
  return undefined
}

/** 操作在“正向”（after 方向）时的目标当前值。 */
function currentValueOf(document: StudioDocument, op: PatchOp): unknown {
  switch (op.kind) {
    case 'project-set':
      return document[op.field]
    case 'scene-set': {
      const scene = findScene(document, op.sceneId)
      return scene ? sceneMeta(scene) : null
    }
    case 'scene-order':
      return document.scenes.map((scene) => scene.id)
    case 'cue-set': {
      const cue = findCue(document, op.cueId)
      return cue ? clone(cue) : null
    }
    case 'cue-order':
      return findScene(document, op.sceneId)?.cues.map((cue) => cue.id) ?? []
  }
}

/* ---- 写入单个值（幂等：目标已是要写入的值时不动） ---- */

function writeValue(document: StudioDocument, op: PatchOp, value: unknown) {
  switch (op.kind) {
    case 'project-set':
      ;(document[op.field] as string | number) = value as string | number
      return
    case 'scene-set': {
      const meta = value as SceneMeta | null
      const index = document.scenes.findIndex((scene) => scene.id === op.sceneId)
      if (meta === null) {
        if (index >= 0) document.scenes.splice(index, 1)
        return
      }
      if (index < 0) document.scenes.push({ ...clone(meta), cues: [] })
      else Object.assign(document.scenes[index], clone(meta))
      return
    }
    case 'scene-order': {
      const order = value as string[]
      const byId = new Map(document.scenes.map((scene) => [scene.id, scene]))
      const next = order.map((id) => byId.get(id)).filter((scene): scene is Scene => Boolean(scene))
      for (const scene of document.scenes) if (!next.includes(scene)) next.push(scene)
      document.scenes = next
      return
    }
    case 'cue-set': {
      const cue = value as Cue | null
      const scene = findScene(document, op.sceneId) ?? document.scenes.find((item) => item.cues.some((entry) => entry.id === op.cueId))
      if (cue === null) {
        // 删除：可能已被别场移动过，按 id 全文档找
        for (const host of document.scenes) {
          const at = host.cues.findIndex((entry) => entry.id === op.cueId)
          if (at >= 0) host.cues.splice(at, 1)
        }
        return
      }
      if (!scene) return
      const at = scene.cues.findIndex((entry) => entry.id === op.cueId)
      if (at >= 0) scene.cues[at] = clone(cue)
      else scene.cues.splice(Math.min(op.index, scene.cues.length), 0, clone(cue))
      return
    }
    case 'cue-order': {
      const scene = findScene(document, op.sceneId)
      if (!scene) return
      const order = value as string[]
      const byId = new Map(scene.cues.map((cue) => [cue.id, cue]))
      const next = order.map((id) => byId.get(id)).filter((cue): cue is Cue => Boolean(cue))
      for (const cue of scene.cues) if (!next.includes(cue)) next.push(cue)
      scene.cues = next
      return
    }
  }
}

/**
 * 规划一次合入：逐条比对操作目标与草稿当前值。
 * - accept：补丁基于 op.before，当前值等于 before → 干净合入 after；
 *   当前值已是 after → 已生效，跳过；都不是 → 双方改过同一条，记冲突。
 * - reject：反向，把 after 还原成 before，冲突判定同理。
 */
export function planMerge(document: StudioDocument, patch: Patch, action: 'accept' | 'reject') {
  const conflicts: OpConflict[] = []
  const clean: Array<{ op: PatchOp; value: unknown }> = []
  patch.ops.forEach((op, opIndex) => {
    const base = action === 'accept' ? op.before : op.after
    const target = action === 'accept' ? op.after : op.before
    const current = currentValueOf(document, op)
    if (equal(current, target)) return // 已生效，重试也不会重复应用
    if (equal(current, base)) {
      clean.push({ op, value: target })
      return
    }
    conflicts.push({ opIndex, current, incoming: target })
  })
  return { clean, conflicts }
}

/** 应用规划结果；conflicts 里导演选 incoming 的条目也一并写入。 */
export function applyMerge(document: StudioDocument, patch: Patch, clean: Array<{ op: PatchOp; value: unknown }>, conflicts: OpConflict[]) {
  const next = clone(document)
  for (const { op, value } of clean) writeValue(next, op, value)
  for (const conflict of conflicts) {
    if (conflict.choice !== 'incoming') continue
    writeValue(next, patch.ops[conflict.opIndex], conflict.incoming)
  }
  return next
}

/** 直接正/反向应用整组操作（编辑提交、撤销重做用），本身幂等。 */
export function applyOps(document: StudioDocument, ops: PatchOp[], direction: 'forward' | 'reverse'): StudioDocument {
  const next = clone(document)
  for (const op of ops) writeValue(next, op, direction === 'forward' ? op.after : op.before)
  return next
}

export interface OpSummary {
  dialogue: number
  sfx: number
  transition: number
  scene: number
  order: number
  project: number
}

/** 按涉及的台词 / 音效提示 / 转场等归类统计，用于列表展示。 */
export function summarizeOps(ops: PatchOp[]): OpSummary {
  const summary: OpSummary = { dialogue: 0, sfx: 0, transition: 0, scene: 0, order: 0, project: 0 }
  for (const op of ops) {
    if (op.kind === 'project-set') summary.project += 1
    else if (op.kind === 'scene-set') summary.scene += 1
    else if (op.kind === 'scene-order' || op.kind === 'cue-order') summary.order += 1
    else {
      const cue = op.after ?? op.before
      if (cue?.kind === 'dialogue') summary.dialogue += 1
      else if (cue?.kind === 'sfx') summary.sfx += 1
      else summary.transition += 1
    }
  }
  return summary
}

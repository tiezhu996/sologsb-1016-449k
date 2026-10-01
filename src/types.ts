export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2

export interface Character {
  id: string
  name: string
  voiceActor: string
  color: string
}

export interface SoundEffect {
  id: string
  name: string
  duration: number
  source: string
  note: string
}

export interface Cue {
  id: string
  kind: CueKind
  characterId?: string
  text: string
  emotion: string
  rate: Rate
  soundEffectId?: string
  transition: string
  manualDuration?: number
}

export interface Scene {
  id: string
  code: string
  title: string
  location: string
  timeOfDay: string
  transition: string
  durationLimit: number
  cues: Cue[]
}

export interface StudioDocument {
  title: string
  subtitle: string
  targetDuration: number
  characters: Character[]
  soundEffects: SoundEffect[]
  scenes: Scene[]
}

/** 场次除提示列表外的元信息。 */
export type SceneMeta = Omit<Scene, 'cues'>

/**
 * 补丁操作：每条只触及一个台词 / 音效提示 / 场次 / 项目字段，
 * 并同时记录修改前后的值，合入时按内容逐条比对。
 */
export type PatchOp =
  | { kind: 'project-set'; field: 'title' | 'subtitle' | 'targetDuration'; before: string | number; after: string | number }
  | { kind: 'scene-set'; sceneId: string; before: SceneMeta | null; after: SceneMeta | null }
  | { kind: 'scene-order'; before: string[]; after: string[] }
  | { kind: 'cue-set'; sceneId: string; cueId: string; index: number; before: Cue | null; after: Cue | null }
  | { kind: 'cue-order'; sceneId: string; before: string[]; after: string[] }

export type PatchStatus = 'pending' | 'accepted' | 'rejected' | 'conflict'

/** 一条操作的冲突：当前草稿与补丁（或退回目标）同时改了同一条内容。 */
export interface OpConflict {
  opIndex: number
  /** 当前草稿里的值（可能为 null，表示已被删除）。 */
  current: unknown
  /** 合入想要写入的值：接受时是补丁版本，退回时是退回目标。 */
  incoming: unknown
  /** 导演选定前合入暂停。 */
  choice?: 'current' | 'incoming'
}

export interface PatchMerge {
  action: 'accept' | 'reject'
  conflicts: OpConflict[]
}

export interface Patch {
  id: string
  label: string
  note: string
  createdAt: string
  /** 补丁基于的草稿版本号。 */
  baseRev: number
  ops: PatchOp[]
  status: PatchStatus
  resolvedAt?: string
  /** 冲突待导演选定时挂在这里。 */
  merge?: PatchMerge
}

/** 当前草稿独立保存：版本号 + 文档 + 已生效批次（幂等重试用）。 */
export interface DraftStore {
  rev: number
  document: StudioDocument
  appliedBatches: string[]
  updatedAt: string
}

export interface FrozenVersion {
  id: string
  name: string
  createdAt: string
  document: StudioDocument
  totalDuration: number
}

/** 写入失败时保留的检查点：整批补丁 + 原稿，恢复或重试都靠它。 */
export interface Checkpoint {
  batchId: string
  label: string
  savedAt: string
  draft: DraftStore
  patches: Patch[]
  frozen: FrozenVersion[]
}

export interface WarningItem {
  id: string
  type: 'collision' | 'missing-sfx' | 'over-time'
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  title: string
  detail: string
}

/* ---- 旧版整份快照格式（仅用于迁移） ---- */

export interface LegacyPendingChange {
  id: string
  label: string
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected'
  before: StudioDocument
  after: StudioDocument
  note: string
}

export interface LegacyStudioState {
  document: StudioDocument
  pending: LegacyPendingChange[]
  frozen: FrozenVersion[]
  updatedAt: string
}

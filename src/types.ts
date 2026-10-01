export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2
export type Role = 'writer' | 'director'

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

/** 补丁可携带的字段值（均为 JSON 标量，undefined 表示清空）。 */
export type FieldValue = string | number | undefined

export type PatchOpType = 'set' | 'add' | 'remove' | 'move'

export interface SetOp {
  type: 'set'
  target: 'project' | 'scene' | 'cue' | 'character' | 'soundEffect'
  field: string
  value: FieldValue
  oldValue: FieldValue
  sceneId?: string
  cueId?: string
  /** target 为 character / soundEffect 时的库条目 id。 */
  itemId?: string
}

export interface AddOp {
  type: 'add'
  target: 'scene' | 'cue' | 'character' | 'soundEffect'
  index: number
  /** target 为 scene 时的整份快照。 */
  scene?: Scene
  /** target 为 cue 时的整份快照。 */
  cue?: Cue
  /** target 为 cue 时所属场次。 */
  sceneId?: string
  cueId?: string
  /** target 为 character / soundEffect 时的整份快照。 */
  character?: Character
  soundEffect?: SoundEffect
  itemId?: string
}

export interface RemoveOp {
  type: 'remove'
  target: 'scene' | 'cue' | 'character' | 'soundEffect'
  index: number
  sceneId: string
  cueId?: string
  itemId?: string
  /** 删除时留存的快照，退回时据此恢复。 */
  scene?: Scene
  cue?: Cue
  character?: Character
  soundEffect?: SoundEffect
}

export interface MoveOp {
  type: 'move'
  target: 'scene' | 'cue' | 'character' | 'soundEffect'
  id: string
  from: number
  to: number
  /** target 为 cue 时所属场次。 */
  sceneId?: string
}

export type PatchOp = SetOp | AddOp | RemoveOp | MoveOp

export type PatchStatus = 'pending' | 'accepted' | 'rejected'
export type ConflictContext = 'accept' | 'reject'
export type ConflictResolution = 'take-patch' | 'keep-live'

/** 已持久化的冲突项：记录导演对某条操作的选定，以及选定时的并列文案。 */
export interface ConflictHunk {
  id: string
  opIndex: number
  context: ConflictContext
  resolution: ConflictResolution
  baseText: string
  patchText: string
  liveText: string
}

export interface Patch {
  id: string
  label: string
  note: string
  /** 提交方：编剧或导演，同一场次两边各自整理时据此区分并列版本。 */
  author: Role
  createdAt: string
  decidedAt?: string
  status: PatchStatus
  /** 该补丁基于的稿次。 */
  baseRevision: number
  /** 实际合入时的稿次。 */
  appliedRevision?: number
  /** 一次“全部接受”共用同一批次号，重试时跳过已生效批次。 */
  batchId?: string
  ops: PatchOp[]
  hunks: ConflictHunk[]
  /** 由旧版整份快照迁移而来。 */
  migrated?: boolean
}

export interface DraftState {
  document: StudioDocument
  /** 单调稿次：工作稿每发生一次落库变更递增。 */
  revision: number
}

export interface FrozenVersion {
  id: string
  name: string
  createdAt: string
  document: StudioDocument
  totalDuration: number
}

export interface MetaState {
  role: Role
  notice?: {
    kind: 'migrated' | 'recovered'
    text: string
    at: string
  }
}

/** 多键写入前留存的检查点，仅覆盖本次事务涉及的分区。 */
export interface Checkpoint {
  id: string
  createdAt: string
  label: string
  pre: Partial<Record<StoreSection, unknown>>
}

export type StoreSection = 'draft' | 'patches' | 'frozen' | 'meta'

export interface WarningItem {
  id: string
  type: 'collision' | 'missing-sfx' | 'over-time'
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  title: string
  detail: string
}

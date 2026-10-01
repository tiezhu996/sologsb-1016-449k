import { diffDocuments } from './patches'
import type {
  Checkpoint,
  DraftState,
  FrozenVersion,
  MetaState,
  Patch,
  Role,
  StoreSection,
  StudioDocument
} from './types'

/**
 * 三份数据分开保存：
 * - draft   当前工作草稿（带单调稿次）
 * - patches 待确认补丁队列（每条记住 baseRevision）
 * - frozen  冻结版本
 * 每次多分区写入都先留检查点；写入失败时按检查点回滚并保留检查点与原稿。
 */

const DRAFT_KEY = 'sologsb-1016-studio-draft-v2'
const PATCHES_KEY = 'sologsb-1016-studio-patches-v2'
const FROZEN_KEY = 'sologsb-1016-studio-frozen-v2'
const META_KEY = 'sologsb-1016-studio-meta-v2'
const CHECKPOINT_KEY = 'sologsb-1016-studio-checkpoints-v2'
const LEGACY_KEY = 'sologsb-1016-studio-v1'
const LEGACY_BACKUP_KEY = 'sologsb-1016-studio-v1-migrated-backup'

const SECTION_KEYS: Record<StoreSection, string> = {
  draft: DRAFT_KEY,
  patches: PATCHES_KEY,
  frozen: FROZEN_KEY,
  meta: META_KEY
}

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export interface LoadedStore {
  draft: DraftState
  patches: Patch[]
  frozen: FrozenVersion[]
  meta: MetaState
  recovered: boolean
}

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}

function latestCheckpoint(): Checkpoint | undefined {
  const list = readJson<Checkpoint[]>(CHECKPOINT_KEY) ?? []
  return list[list.length - 1]
}

/**
 * 事务式写入：先落检查点，再逐分区写入；任一步失败立即用检查点
 * 回滚已写入的分区，并把检查点保留下来供「恢复检查点」使用。
 * 返回错误信息；成功返回 undefined。
 */
export function transaction(label: string, updates: Partial<Record<StoreSection, unknown>>): string | undefined {
  const sections = Object.keys(updates) as StoreSection[]
  if (!sections.length) return undefined

  const pre: Checkpoint['pre'] = {}
  for (const section of sections) {
    const raw = localStorage.getItem(SECTION_KEYS[section])
    pre[section] = raw ? (() => {
      try { return JSON.parse(raw) } catch { return undefined }
    })() : null
  }

  const checkpoint: Checkpoint = { id: uid('cp'), createdAt: new Date().toISOString(), label, pre }
  let checkpoints = readJson<Checkpoint[]>(CHECKPOINT_KEY) ?? []
  checkpoints.push(checkpoint)
  checkpoints = checkpoints.slice(-5)

  const writeKeys: string[] = []
  const rollback = () => {
    for (let i = writeKeys.length - 1; i >= 0; i -= 1) {
      const key = writeKeys[i]
      const section = sections.find((item) => SECTION_KEYS[item] === key)
      if (!section) continue
      const snapshot = pre[section]
      try {
        if (snapshot === null || snapshot === undefined) localStorage.removeItem(key)
        else localStorage.setItem(key, JSON.stringify(snapshot))
      } catch {
        // 回滚本身尽力而为；检查点仍保留在本地，用户可手动恢复。
      }
    }
    // 回滚后保留检查点与原稿，不弹出检查点记录。
    try { localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoints)) } catch { /* 忽略 */ }
  }

  try {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoints))
  } catch (error) {
    return `写入检查点失败：${(error as Error).message}`
  }

  for (const section of sections) {
    const key = SECTION_KEYS[section]
    try {
      localStorage.setItem(key, JSON.stringify(updates[section]))
      writeKeys.push(key)
    } catch (error) {
      rollback()
      return `保存「${label}」失败，已回滚到检查点：${(error as Error).message}`
    }
  }
  return undefined
}

export function listCheckpoints(): Checkpoint[] {
  return readJson<Checkpoint[]>(CHECKPOINT_KEY) ?? []
}

/** 手动恢复某个检查点涉及的分区。 */
export function restoreCheckpoint(checkpointId: string): string | undefined {
  const checkpoint = listCheckpoints().find((item) => item.id === checkpointId)
  if (!checkpoint) return '检查点不存在或已被清理'
  const updates: Partial<Record<StoreSection, unknown>> = {}
  for (const [section, snapshot] of Object.entries(checkpoint.pre) as [StoreSection, unknown][]) {
    if (snapshot !== null && snapshot !== undefined) updates[section] = snapshot
  }
  const error = transaction(`恢复检查点：${checkpoint.label}`, updates)
  if (error) return error
  // 检查点创建时尚不存在的分区，恢复时移除。
  for (const [section, snapshot] of Object.entries(checkpoint.pre) as [StoreSection, unknown][]) {
    if (snapshot === null) {
      try { localStorage.removeItem(SECTION_KEYS[section]) } catch { /* 忽略 */ }
    }
  }
  return undefined
}

/* ------------------------- 旧版整份快照迁移 ------------------------- */

interface LegacyChange {
  id: string
  label: string
  note: string
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected'
  before: StudioDocument
  after: StudioDocument
}

interface LegacyState {
  document: StudioDocument
  pending: LegacyChange[]
  frozen: FrozenVersion[]
  updatedAt?: string
}

function migrateLegacy(legacy: LegacyState, role: Role): { store: LoadedStore; notice: string } | undefined {
  // 旧稿没有稿次概念：v1 加载时的 document 就是「所有修改后的现稿」，
  // 最早一条 before 即基准稿；逐条重放并 diff 成补丁继续使用。
  const ordered = [...legacy.pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  let cursor: StudioDocument | undefined
  for (const change of ordered) {
    if (!cursor) cursor = change.before
    cursor = change.after
  }
  if (!cursor) return undefined

  const patches: Patch[] = []
  let running = (() => {
    const first = ordered[0]
    return first ? first.before : legacy.document
  })()

  ordered.forEach((change, index) => {
    const ops = diffDocuments(running, change.after)
    if (!ops.length) return
    patches.push({
      id: change.id,
      label: change.label,
      note: change.note,
      author: role,
      createdAt: change.createdAt,
      status: change.status,
      decidedAt: change.status === 'pending' ? undefined : change.createdAt,
      baseRevision: index,
      appliedRevision: index + 1,
      ops,
      hunks: [],
      migrated: true
    })
    running = change.after
  })

  const store: LoadedStore = {
    draft: { document: legacy.document, revision: patches.length },
    patches,
    frozen: legacy.frozen ?? [],
    meta: {
      role,
      notice: {
        kind: 'migrated',
        text: `旧版待确认区保存的是整份前后稿，已自动拆成 ${patches.length} 条补丁；补丁均带基准稿次，可继续接受或退回。`,
        at: new Date().toISOString()
      }
    },
    recovered: false
  }

  try {
    localStorage.setItem(LEGACY_BACKUP_KEY, JSON.stringify(legacy))
  } catch {
    // 备份失败不阻塞迁移。
  }
  return { store, notice: store.meta.notice!.text }
}

/* ------------------------- 启动加载 ------------------------- */

export function loadStore(defaultDraft: () => DraftState, role: Role): LoadedStore {
  const draft = readJson<DraftState>(DRAFT_KEY)
  if (draft?.document?.scenes) {
    // 检查点回滚恢复：若上一次事务失败留下检查点且其内容比新稿旧，
    // 这里不自动覆盖，仅标记由界面提示用户选择恢复。
    return {
      draft,
      patches: readJson<Patch[]>(PATCHES_KEY) ?? [],
      frozen: readJson<FrozenVersion[]>(FROZEN_KEY) ?? [],
      meta: readJson<MetaState>(META_KEY) ?? { role },
      recovered: false
    }
  }

  // 旧草稿只有整份快照时转成补丁继续使用。
  const legacy = readJson<LegacyState>(LEGACY_KEY)
  if (legacy?.document?.scenes) {
    const migrated = migrateLegacy(legacy, role)
    if (migrated) {
      const error = transaction('迁移旧版整份快照', {
        draft: migrated.store.draft,
        patches: migrated.store.patches,
        frozen: migrated.store.frozen,
        meta: migrated.store.meta
      })
      if (!error) localStorage.removeItem(LEGACY_KEY)
      return migrated.store
    }
  }

  const fallback = defaultDraft()
  return {
    draft: fallback,
    patches: [],
    frozen: [],
    meta: { role },
    recovered: false
  }
}

export function checkpointCount(): number {
  return listCheckpoints().length
}

/** 从磁盘重新读取四个分区（恢复检查点后用于刷新内存）。 */
export function readSnapshot(role: Role): { draft: DraftState; patches: Patch[]; frozen: FrozenVersion[]; meta: MetaState } | undefined {
  const draft = readJson<DraftState>(DRAFT_KEY)
  if (!draft?.document?.scenes) return undefined
  return {
    draft,
    patches: readJson<Patch[]>(PATCHES_KEY) ?? [],
    frozen: readJson<FrozenVersion[]>(FROZEN_KEY) ?? [],
    meta: readJson<MetaState>(META_KEY) ?? { role }
  }
}

export function makePatchId(): string {
  return uid('patch')
}
export function makeBatchId(): string {
  return uid('batch')
}
export function makeId(prefix: string): string {
  return uid(prefix)
}

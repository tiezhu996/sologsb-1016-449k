import { diffDocuments } from './patch'
import type { Checkpoint, DraftStore, FrozenVersion, LegacyStudioState, Patch } from './types'

/** 当前草稿、待确认补丁、冻结版本分开保存，互不覆盖。 */
export const DRAFT_KEY = 'sologsb-1016:draft:v2'
export const PATCHES_KEY = 'sologsb-1016:patches:v2'
export const FROZEN_KEY = 'sologsb-1016:frozen:v2'
export const CHECKPOINT_KEY = 'sologsb-1016:checkpoint:v2'
const LEGACY_KEY = 'sologsb-1016-studio-v1'

export class PersistError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersistError'
  }
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    throw new PersistError(error instanceof Error ? error.message : String(error))
  }
}

export function loadDraftStore(): DraftStore | null {
  const store = read<DraftStore>(DRAFT_KEY)
  return store?.document?.scenes?.length ? store : null
}

export function loadPatches(): Patch[] {
  return read<Patch[]>(PATCHES_KEY) ?? []
}

export function loadFrozen(): FrozenVersion[] {
  return read<FrozenVersion[]>(FROZEN_KEY) ?? []
}

/** 三个存储一起落盘；任何一个失败都抛错，由调用方保留检查点。 */
export function saveStores(draft: DraftStore, patches: Patch[], frozen: FrozenVersion[]) {
  write(PATCHES_KEY, patches)
  write(FROZEN_KEY, frozen)
  // 草稿最后写：appliedBatches 记录已生效批次，是“本批已完成”的标记
  write(DRAFT_KEY, draft)
}

export function writeCheckpoint(checkpoint: Checkpoint) {
  try {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint))
  } catch {
    // 检查点本身写不进去也不能挡住编辑，原稿仍在各存储里
  }
}

export function readCheckpoint(): Checkpoint | null {
  return read<Checkpoint>(CHECKPOINT_KEY)
}

export function clearCheckpoint() {
  try {
    localStorage.removeItem(CHECKPOINT_KEY)
  } catch {
    // ignore
  }
}

/**
 * 启动时恢复：上次一批写入中途失败时，检查点里的批次号不会出现在
 * 草稿的 appliedBatches 里，此时把检查点（原稿 + 原补丁）写回，保证
 * 这批补丁重试时不会重复生效。
 */
export function recoverFromCheckpoint(): boolean {
  const checkpoint = readCheckpoint()
  if (!checkpoint?.draft?.document) return false
  const draft = loadDraftStore()
  if (draft && draft.appliedBatches.includes(checkpoint.batchId)) {
    clearCheckpoint()
    return false
  }
  try {
    write(PATCHES_KEY, checkpoint.patches)
    write(FROZEN_KEY, checkpoint.frozen)
    write(DRAFT_KEY, checkpoint.draft)
    clearCheckpoint()
    return true
  } catch {
    return false
  }
}

/**
 * 旧版只有整份前后快照：逐条 diff 成补丁，按时间顺序接上版本号，
 * 状态保留，迁移后删除旧键。迁移失败时保留旧数据不丢。
 */
export function migrateLegacyState(): { draft: DraftStore; patches: Patch[]; frozen: FrozenVersion[] } | null {
  const legacy = read<LegacyStudioState>(LEGACY_KEY)
  if (!legacy?.document?.scenes?.length) return null

  let rev = 0
  const patches: Patch[] = []
  const ordered = [...(legacy.pending ?? [])].reverse() // 旧数组新的在前，翻成时间正序
  for (const change of ordered) {
    if (!change.before || !change.after) continue
    const ops = diffDocuments(change.before, change.after)
    if (!ops.length) continue
    patches.push({
      id: change.id || `legacy-${patches.length}`,
      label: change.label || '历史修改',
      note: change.note ?? '',
      createdAt: change.createdAt || new Date().toISOString(),
      baseRev: rev,
      ops,
      status: change.status === 'accepted' ? 'accepted' : change.status === 'rejected' ? 'rejected' : 'pending'
    })
    rev += 1
  }

  const draft: DraftStore = {
    rev,
    document: legacy.document,
    appliedBatches: patches.filter((patch) => patch.status !== 'pending').map((patch) => patch.id),
    updatedAt: legacy.updatedAt || new Date().toISOString()
  }
  const frozen = legacy.frozen ?? []

  try {
    saveStores(draft, patches, frozen)
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // 落盘失败：内存里先用迁移结果，旧键保留，下次启动会重试迁移（幂等）
  }
  return { draft, patches, frozen }
}

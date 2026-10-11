import { MAX_BACKUP_BYTES, parseBackup } from '../services/backup.ts'
import { normalizeTrash } from '../services/appState.ts'
import type { WorkspaceData } from '../types/request'

export type WorkspaceRecord = Record<string, unknown>
export type NativeStorageInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>
export type NativeWorkspaceBackup = { id: number; createdAt: number; size: number }
export type LegacyWorkspace = { record: WorkspaceRecord; remove: () => void }
type LegacyStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'>

export function collectLegacyWorkspace(storage: LegacyStorage): LegacyWorkspace | undefined {
  const known = ['workspace', 'collections', 'requests', 'environments', 'environmentId', 'cookies', 'history', 'trash', 'theme', 'tabs', 'updates', 'navigationCollapsed', 'runnerScenarios']
  const keys = new Set(known.map(key => `reqdesk.${key}`))
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key?.startsWith('reqdesk.')) keys.add(key) }
  keys.add('reqmas.navigation.collapsed')
  const found: [string, unknown][] = [], cleanup: string[] = []
  let combined: WorkspaceRecord = {}
  for (const key of keys) {
    const text = storage.getItem(key)
    if (text === null) continue
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new Error(`Cannot migrate ${key}: saved data contains invalid JSON. Export or repair the existing workspace before retrying.`) }
    cleanup.push(key)
    if (key === 'reqdesk.workspace') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cannot migrate the existing workspace: its document is invalid.')
      combined = value as WorkspaceRecord
    } else found.push([key === 'reqmas.navigation.collapsed' ? 'navigationCollapsed' : key.slice('reqdesk.'.length), value])
  }
  if (!cleanup.length) return undefined
  const fields = { ...Object.fromEntries(found), ...combined }
  const record: WorkspaceRecord = { collections: [], requests: [], environments: [], environmentId: '', cookies: [], history: [], trash: { requests: [], collections: [] }, ...fields }
  // Very old builds saved requests separately and relied on the default Demo API collection.
  if (!Object.hasOwn(fields, 'collections') && Array.isArray(record.requests)) {
    const ids = new Set<string>()
    for (const entry of record.requests) if (entry && typeof entry === 'object' && typeof entry.collectionId === 'string') ids.add(entry.collectionId)
    record.collections = [...ids].map(id => ({ id, name: id === 'demo' ? 'Demo API' : 'Recovered collection' }))
  }
  return { record, remove: () => { for (const key of cleanup) storage.removeItem(key) } }
}

function errorFor(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)) }
export function parseWorkspaceRecord(value: unknown): WorkspaceRecord {
  if (typeof value !== 'string') throw new Error('Workspace storage returned an invalid document.')
  if (value.length > MAX_BACKUP_BYTES || new TextEncoder().encode(value).length > MAX_BACKUP_BYTES) throw new Error('Workspace exceeds the 50 MiB limit.')
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('Workspace storage contains invalid JSON. Restore a valid backup before editing.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Workspace storage contains an invalid document.')
  const record = parsed as WorkspaceRecord
  for (const key of ['collections', 'requests', 'environments', 'cookies', 'history']) if (!Array.isArray(record[key])) throw new Error(`Workspace storage is missing ${key}.`)
  if (typeof record.environmentId !== 'string' || !record.trash || typeof record.trash !== 'object' || Array.isArray(record.trash) || !Array.isArray((record.trash as WorkspaceRecord).requests) || !Array.isArray((record.trash as WorkspaceRecord).collections)) throw new Error('Workspace storage contains invalid workspace settings.')
  return record
}

function validateWorkspaceContents(record: WorkspaceRecord): WorkspaceRecord {
  const theme = record.theme === 'dark' || record.theme === 'light' ? record.theme : 'system'
  const drafts = record.tabs === undefined ? [] : Array.isArray(record.tabs) ? record.tabs.map(entry => entry && typeof entry === 'object' ? entry.request : null) : [null]
  const data = { collections: record.collections, requests: record.requests, environments: record.environments, environmentId: record.environmentId, cookies: record.cookies, history: record.history, trash: record.trash, runnerScenarios: record.runnerScenarios }
  parseBackup(JSON.stringify({ format: 'reqmas.workspace', version: 1, exportedAt: '', theme, data, drafts }))
  return record
}

/** Every complete commit must also remain readable by the next application startup. */
export function validateWorkspaceRecord(value: unknown): WorkspaceRecord {
  return validateWorkspaceContents(parseWorkspaceRecord(value))
}

function validateLoadedWorkspace(value: unknown): WorkspaceRecord {
  const record = parseWorkspaceRecord(value)
  const trash = record.trash as WorkspaceData['trash']
  // Older builds could delete the same request again after saving its history snapshot.
  // Repair those duplicate IDs before strict backup validation blocks startup.
  if ([...trash.requests, ...trash.collections].every(entry => entry && typeof entry === 'object' && typeof entry.id === 'string')) record.trash = normalizeTrash(trash)
  return validateWorkspaceContents(record)
}

/** SQLite commits stay ordered while React continues using the synchronous cache. */
export function createDesktopWorkspaceStore(invoke: NativeStorageInvoke, loadLegacy: () => LegacyWorkspace | undefined, onError: (error: Error) => void) {
  let cache: WorkspaceRecord | undefined, initializing: Promise<void> | undefined, migrationCleanup: (() => void) | undefined
  let queue: Promise<void> = Promise.resolve(), lastError: Error | undefined, restoring = false
  const get = () => {
    if (!cache) throw new Error('Workspace storage has not finished loading.')
    return cache
  }
  const commit = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation)
    queue = result.then(() => { lastError = undefined }, error => { lastError = errorFor(error); onError(lastError) })
    return result
  }
  const initialize = async () => {
    if (cache) return
    if (initializing) return initializing
    initializing = (async () => {
      const stored = await invoke('load_workspace', {})
      if (stored !== null) {
        const loaded = validateLoadedWorkspace(stored)
        if (migrationCleanup) { migrationCleanup(); migrationCleanup = undefined }
        cache = loaded; return
      }
      const legacy = loadLegacy()
      if (legacy) {
        const migrated = validateLoadedWorkspace(JSON.stringify(legacy.record))
        const text = JSON.stringify(migrated)
        await invoke('save_workspace', { workspace: text })
        migrationCleanup = legacy.remove
        migrationCleanup(); migrationCleanup = undefined
        cache = migrated
      } else cache = {}
    })()
    try { await initializing }
    finally { initializing = undefined }
  }
  const replace = (record: WorkspaceRecord) => {
    get()
    if (restoring) throw new Error('Workspace restoration is still in progress.')
    const workspace = JSON.stringify(record)
    validateWorkspaceRecord(workspace)
    cache = record
    void commit(() => invoke('save_workspace', { workspace })).catch(() => { /* The queue records the failure and reports it to the application. */ })
  }
  const restore = async (record: WorkspaceRecord) => {
    get()
    if (restoring) throw new Error('Workspace restoration is already in progress.')
    const workspace = JSON.stringify(record)
    validateWorkspaceRecord(workspace)
    restoring = true
    try { await commit(() => invoke('save_workspace', { workspace, forceBackup: true })); cache = record }
    finally { restoring = false }
  }
  const metadata = (key: string, value: unknown) => {
    const record = { ...get(), [key]: value }
    if (restoring) throw new Error('Workspace restoration is still in progress.')
    // Child effects save tabs/theme before the parent writes a new workspace.
    if (!Object.hasOwn(record, 'collections')) { JSON.stringify(record); cache = record }
    else replace(record)
  }
  const flush = async () => {
    let pending: Promise<void>
    do { pending = queue; await pending } while (pending !== queue)
    if (lastError) throw lastError
  }
  const listBackups = async (): Promise<NativeWorkspaceBackup[]> => { await flush(); return await invoke('list_workspace_backups', {}) as NativeWorkspaceBackup[] }
  const retry = async () => {
    await queue
    if (lastError) {
      const workspace = JSON.stringify(get())
      validateWorkspaceRecord(workspace)
      await commit(() => invoke('save_workspace', { workspace }))
    }
    await flush()
  }
  const loadBackup = async (backupId: number): Promise<WorkspaceRecord> => {
    if (!Number.isSafeInteger(backupId) || backupId <= 0) throw new Error('Choose a valid workspace backup.')
    await flush()
    return validateLoadedWorkspace(await invoke('read_workspace_backup', { backupId }))
  }
  const restoreBackup = async (backupId: number): Promise<WorkspaceRecord> => {
    get()
    if (!Number.isSafeInteger(backupId) || backupId <= 0) throw new Error('Choose a valid workspace backup.')
    if (restoring) throw new Error('Workspace restoration is already in progress.')
    restoring = true
    try {
      const restored = await commit(async () => {
        // Validate the preview before the native command changes the current database.
        validateLoadedWorkspace(await invoke('read_workspace_backup', { backupId }))
        return validateLoadedWorkspace(await invoke('restore_workspace_backup', { backupId }))
      })
      cache = restored
      return restored
    } finally { restoring = false }
  }
  return { initialize, get, replace, metadata, restore, flush, retry, listBackups, loadBackup, restoreBackup }
}

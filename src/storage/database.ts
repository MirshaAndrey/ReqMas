import type { Request, WorkspaceData } from '../types/request'
import { invoke } from '@tauri-apps/api/core'
import { collectLegacyWorkspace, createDesktopWorkspaceStore, validateWorkspaceRecord } from './desktopStore.ts'
import type { NativeWorkspaceBackup, WorkspaceRecord } from './desktopStore'

export type { NativeWorkspaceBackup } from './desktopStore'
export const desktopStorage = () => Object.hasOwn(globalThis, '__TAURI_INTERNALS__')
function reportStorageError(error: Error) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('reqmas-storage-error', { detail: error.message }))
}
const nativeStore = createDesktopWorkspaceStore(async (command, args) => {
  return invoke(command, args)
}, () => collectLegacyWorkspace(localStorage), reportStorageError)

export async function initializeStorage() { if (desktopStorage()) await nativeStore.initialize() }
export async function flushStorage(retryFailed = false) { if (desktopStorage()) await (retryFailed ? nativeStore.retry() : nativeStore.flush()) }
export async function listWorkspaceBackups(): Promise<NativeWorkspaceBackup[]> { return desktopStorage() ? nativeStore.listBackups() : [] }
export async function loadWorkspaceBackup(backupId: number): Promise<WorkspaceRecord> {
  if (!desktopStorage()) throw new Error('Automatic workspace backups are available in the desktop application.')
  return nativeStore.loadBackup(backupId)
}
export async function readWorkspaceBackup(backupId: number): Promise<string> { return JSON.stringify(await loadWorkspaceBackup(backupId)) }
export async function restoreDesktopBackup(backupId: number): Promise<WorkspaceRecord> {
  if (!desktopStorage()) throw new Error('Automatic workspace backups are available in the desktop application.')
  return nativeStore.restoreBackup(backupId)
}

function workspaceRecord(): Record<string, unknown> | undefined {
  if (desktopStorage()) return nativeStore.get()
  try {
    const value = JSON.parse(localStorage.getItem('reqdesk.workspace') ?? 'null')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch { return undefined }
}

// Keep the original namespace so renaming the app to Reqmas preserves saved work.
export function read<T>(key: string, fallback: T): T {
  try {
    const workspace = workspaceRecord()
    if (workspace && Object.hasOwn(workspace, key)) return (workspace[key] ?? fallback) as T
    if (desktopStorage()) return fallback
    return JSON.parse(localStorage.getItem(`reqdesk.${key}`) ?? 'null') ?? fallback
  } catch { return fallback }
}
export function write(key: string, value: unknown) {
  const workspace = workspaceRecord()
  if (desktopStorage()) {
    nativeStore.metadata(key, value)
  } else if (workspace) {
    const text = JSON.stringify({ ...workspace, [key]: value })
    validateWorkspaceRecord(text)
    localStorage.setItem('reqdesk.workspace', text)
  } else localStorage.setItem(`reqdesk.${key}`, JSON.stringify(value))
}
// A single setItem keeps all workspace records consistent if storage is full.
export function writeWorkspace(data: WorkspaceData) {
  const theme = read('theme', 'system'), tabs = read('tabs', [])
  const record = { ...workspaceRecord(), ...data, theme, tabs }
  if (desktopStorage()) nativeStore.replace(record)
  else { const text = JSON.stringify(record); validateWorkspaceRecord(text); localStorage.setItem('reqdesk.workspace', text) }
}
// Imports can validate their combined result before changing React state or announcing success.
export function validateWorkspaceUpdate(data: WorkspaceData, drafts: Request[]) {
  const record = { ...workspaceRecord(), ...data, theme: read('theme', 'system'), tabs: drafts.map(request => ({ request })) }
  validateWorkspaceRecord(JSON.stringify(record))
}
// Commit restored data, drafts and theme before changing any in-memory state.
export function restoreWorkspace(data: WorkspaceData, drafts: Request[], theme: 'light' | 'dark' | 'system') {
  const record = { ...workspaceRecord(), ...data, theme, tabs: drafts.map(request => ({ request })) }
  if (desktopStorage()) return nativeStore.restore(record)
  const text = JSON.stringify(record)
  validateWorkspaceRecord(text)
  localStorage.setItem('reqdesk.workspace', text)
}

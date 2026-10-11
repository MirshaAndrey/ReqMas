import { parseBackup } from './backup.ts'
import type { WorkspaceBackup } from './backup'

export function backupFromStored(json: string): WorkspaceBackup {
  const record = JSON.parse(json)
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Automatic backup contains an invalid workspace.')
  return parseBackup(JSON.stringify({ format: 'reqmas.workspace', version: 1, exportedAt: new Date().toISOString(), theme: record.theme ?? 'system', data: { collections: record.collections, requests: record.requests, history: record.history, trash: record.trash, environments: record.environments, environmentId: record.environmentId, cookies: record.cookies, runnerScenarios: record.runnerScenarios }, drafts: (record.tabs ?? []).map((tab: { request: unknown }) => tab?.request) }))
}

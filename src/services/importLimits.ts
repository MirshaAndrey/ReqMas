import type { Collection, Request } from '../types/request'
import { MAX_BACKUP_BYTES, MAX_BACKUP_ITEMS, validateBackupCollection, validateBackupRequest } from './backup.ts'

export class CollectionImportLimitError extends Error {}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

export function validatePostmanItems(items: unknown[]) {
  const pending = [{ items, depth: 0 }]
  let count = 0
  while (pending.length) {
    const current = pending.pop()!
    if (current.depth > 100) throw new CollectionImportLimitError('Collection folders are nested too deeply. The maximum is 100 folder levels.')
    count += current.items.length
    if (count > MAX_BACKUP_ITEMS) throw new CollectionImportLimitError('Collection has too many items. The maximum is 10,000 requests and folders combined.')
    for (const item of current.items) {
      const children = item !== null && typeof item === 'object' ? (item as { item?: unknown }).item : undefined
      if (Array.isArray(children)) pending.push({ items: children, depth: current.depth + 1 })
    }
  }
}
export function validatePostmanExport(value: { item: unknown[] }) {
  validatePostmanItems(value.item)
  if (new TextEncoder().encode(JSON.stringify(value, null, 2)).length > MAX_BACKUP_BYTES) throw new Error('Collection export exceeds 50 MiB, including embedded files.')
}

/** Apply storage limits while importing, before repeated references expand the document. */
export class CollectionImportBudget {
  private size: number
  private folders: number
  private requests = 0
  constructor(collection: Collection) {
    this.validate(() => validateBackupCollection(collection))
    // Reserve room for the workspace/backup envelope and its empty arrays.
    this.size = bytes(collection) + 1024
    this.folders = collection.folders?.length ?? 0
    this.reserve(0)
  }
  private validate(action: () => void) {
    try { action() } catch (error) {
      throw new CollectionImportLimitError(`Collection cannot be imported: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  private reserve(size: number) {
    if (this.size + size > MAX_BACKUP_BYTES) throw new CollectionImportLimitError('Imported collection exceeds the 50 MiB workspace limit, including generated requests and folders.')
    this.size += size
  }
  addFolder(path: string) {
    if (++this.folders > MAX_BACKUP_ITEMS) throw new CollectionImportLimitError('Imported collection has more than 10,000 folders.')
    this.reserve(bytes(path) + 1)
  }
  addRequest(request: Request) {
    this.validate(() => validateBackupRequest(request))
    if (++this.requests > MAX_BACKUP_ITEMS) throw new CollectionImportLimitError('Imported collection has more than 10,000 requests.')
    this.reserve(bytes(request) + 1)
  }
}

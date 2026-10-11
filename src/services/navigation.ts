import type { Collection, Request } from '../types/request'

export type FolderNode = { path: string; name: string; children: FolderNode[] }

/** Keep explicit folders and infer missing ancestors from imported request paths. */
export function buildFolderTree(folders: string[], requests: Pick<Request, 'folder'>[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>(), roots: FolderNode[] = []
  for (const folder of [...folders, ...requests.map(request => request.folder ?? '')]) {
    let parent: FolderNode | undefined
    const segments = folder.split('/')
    for (let index = 0; index < segments.length; index++) {
      const path = segments.slice(0, index + 1).join('/')
      if (!path) continue
      let node = nodes.get(path)
      if (!node) {
        node = { path, name: segments[index] || '(empty segment)', children: [] }
        nodes.set(path, node)
        if (parent) parent.children.push(node); else roots.push(node)
      }
      parent = node
    }
  }
  return roots
}

export function flattenFolderTree(nodes: FolderNode[]): string[] {
  const result: string[] = [], pending = [...nodes].reverse()
  while (pending.length) {
    const node = pending.pop()!
    result.push(node.path)
    pending.push(...node.children.slice().reverse())
  }
  return result
}

export function navigationMatches(request: Pick<Request, 'name' | 'url' | 'folder'>, collectionName: string, search: string): boolean {
  return `${request.name} ${request.url} ${request.folder ?? ''} ${collectionName}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
}

export function folderMatchesSearch(node: FolderNode, requests: Pick<Request, 'name' | 'url' | 'folder'>[], collectionName: string, search: string): boolean {
  const query = search.trim().toLocaleLowerCase()
  return !query || collectionName.toLocaleLowerCase().includes(query) || flattenFolderTree([node]).some(path => path.toLocaleLowerCase().includes(query)) || requests.some(request => ((request.folder ?? '') === node.path || (request.folder ?? '').startsWith(node.path + '/')) && navigationMatches(request, collectionName, query))
}

/** Array order is the saved order. Requests in other folders retain their relative order. */
export function moveRequestOrder(requests: Request[], requestId: string, collectionId: string, folder = '', beforeRequestId?: string): Request[] {
  const source = requests.find(request => request.id === requestId)
  if (!source) return requests
  if (beforeRequestId === requestId && source.collectionId === collectionId && (source.folder ?? '') === folder) return requests
  const remaining = requests.filter(request => request.id !== requestId)
  const moved = source.collectionId === collectionId && (source.folder ?? '') === folder ? source : { ...source, collectionId, folder: folder || undefined }
  const before = remaining.findIndex(request => request.id === beforeRequestId && request.collectionId === collectionId && (request.folder ?? '') === folder)
  let insertAt = before
  if (insertAt < 0) {
    const folderEnd = remaining.findLastIndex(request => request.collectionId === collectionId && (request.folder ?? '') === folder)
    const collectionEnd = remaining.findLastIndex(request => request.collectionId === collectionId)
    insertAt = folderEnd >= 0 ? folderEnd + 1 : collectionEnd >= 0 ? collectionEnd + 1 : remaining.length
  }
  return [...remaining.slice(0, insertAt), moved, ...remaining.slice(insertAt)]
}

export function moveCollectionOrder(collections: Collection[], collectionId: string, beforeCollectionId?: string): Collection[] {
  const moved = collections.find(collection => collection.id === collectionId)
  if (!moved || beforeCollectionId === collectionId) return collections
  const remaining = collections.filter(collection => collection.id !== collectionId)
  const before = remaining.findIndex(collection => collection.id === beforeCollectionId)
  const insertAt = before < 0 ? remaining.length : before
  return [...remaining.slice(0, insertAt), moved, ...remaining.slice(insertAt)]
}

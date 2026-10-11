import type { Request } from '../types/request'

export function planFolderMove(folders: string[], requestPaths: string[], previous: Record<string, string>, from: string, to: string) {
  const translate = (path: string) => path === from ? to : path.startsWith(from + '/') ? to ? to + path.slice(from.length) : '' : path
  const moves = new Map(Object.entries(previous).map(([key, value]) => [key, translate(value)]))
  for (const path of [...folders, ...requestPaths]) if (!moves.has(path)) moves.set(path, translate(path))
  return { folders: Array.from(new Set(folders.map(translate).filter(Boolean))), moves: Object.fromEntries(moves) }
}

export function moveRequestFolder(request: Request, collectionId: string, moves: Record<string, string>): Request {
  return request.collectionId === collectionId && request.folder && Object.hasOwn(moves, request.folder)
    ? { ...request, folder: moves[request.folder] }
    : request
}

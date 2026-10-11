import type { OAuth, Pair, Request, WorkspaceData } from '../types/request'
import { oauthIdentity, resolveOAuth } from './oauth.ts'
import type { OAuthTokenManager } from './oauth.ts'

/** Keep the most recently deleted version when a history snapshot is saved and deleted again. */
export function mergeDeletedItems<T extends { id: string }>(existing: T[], deleted: T[]): T[] {
  return [...new Map([...existing, ...deleted].map(item => [item.id, item])).values()]
}

export function normalizeTrash(trash: WorkspaceData['trash']): WorkspaceData['trash'] {
  return { requests: mergeDeletedItems([], trash.requests), collections: mergeDeletedItems([], trash.collections) }
}

export function upsertSavedRequest(requests: Request[], request: Request): Request[] {
  const saved = structuredClone(request)
  return requests.some(entry => entry.id === request.id) ? requests.map(entry => entry.id === request.id ? saved : entry) : [...requests, saved]
}

/** Publish rotations only to the captured credential snapshot or its known successors. */
export function renewedOAuth(current: OAuth, source: OAuth, next: OAuth, accountSource: OAuth, variables: Pair[], tokens: Pick<OAuthTokenManager, 'sameGrant'>): OAuth {
  if (oauthIdentity(current) !== oauthIdentity(source)) return current
  try {
    const resolved = resolveOAuth(current, variables), key = oauthIdentity(accountSource)
    if (oauthIdentity(resolved) !== key || !tokens.sameGrant(key, accountSource, resolved)) return current
  } catch { return current }
  return { ...current, accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt }
}

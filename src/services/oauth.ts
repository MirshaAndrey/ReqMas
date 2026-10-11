import type { OAuth, Pair, Request, Response } from '../types/request'
import { resolveVariables } from './prepareRequest.ts'
import { tokenExpiry } from './requestOptions.ts'

export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:58809/oauth/callback'
const pair = (key: string, value: string): Pair => ({ id: crypto.randomUUID(), key, value, enabled: true })
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const formCredential = (value: string) => new URLSearchParams([['', value]]).toString().slice(1)
export async function createPkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  return { verifier, state, challenge }
}
export function validateOAuthUrl(value: string, label: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${label} must be a complete HTTP(S) URL.`) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`${label} must be an HTTP(S) URL without credentials or a fragment.`)
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error(`${label} must use HTTPS (HTTP is allowed only for local testing).`)
  return url
}
export function validateRedirectUri(value: string): URL {
  const url = validateOAuthUrl(value, 'Redirect URI')
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) === 0 || url.search) throw new Error('Redirect URI must use http://127.0.0.1:PORT/path with a fixed port and no query.')
  return url
}
export function resolveOAuth(oauth: OAuth, variables: Pair[]): OAuth {
  return Object.fromEntries(Object.entries(oauth).map(([key, value]) => [key, typeof value === 'string' ? resolveVariables(value, variables) : value])) as OAuth
}
export function authorizationUrl(oauth: OAuth, pkce: { state: string; challenge: string }): string {
  const url = validateOAuthUrl(oauth.authorizationUrl ?? '', 'Authorization URL')
  const redirect = validateRedirectUri(oauth.redirectUri || DEFAULT_REDIRECT_URI)
  if (!oauth.clientId.trim()) throw new Error('Enter an OAuth Client ID.')
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: oauth.clientId, redirect_uri: redirect.toString(), scope: oauth.scope, state: pkce.state, code_challenge: pkce.challenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value)
  return url.toString()
}
export function tokenRequest(source: Request, oauth: OAuth, grant: { code: string; verifier: string } | { refresh: string } | undefined): Request {
  validateOAuthUrl(oauth.tokenUrl, 'Token URL')
  if (!oauth.clientId.trim()) throw new Error('Enter an OAuth Client ID.')
  const form = grant && 'refresh' in grant ? [pair('grant_type', 'refresh_token'), pair('refresh_token', grant.refresh)] : grant ? [pair('grant_type', 'authorization_code'), pair('code', grant.code), pair('code_verifier', grant.verifier), pair('redirect_uri', validateRedirectUri(oauth.redirectUri || DEFAULT_REDIRECT_URI).toString())] : [pair('grant_type', 'client_credentials')]
  if (oauth.scope) form.push(pair('scope', oauth.scope))
  if (oauth.clientAuth !== 'basic') {
    form.push(pair('client_id', oauth.clientId))
    if (oauth.clientSecret) form.push(pair('client_secret', oauth.clientSecret))
  }
  return { id: crypto.randomUUID(), collectionId: source.collectionId, name: grant && 'refresh' in grant ? 'OAuth refresh token' : 'OAuth token', method: 'POST', url: oauth.tokenUrl, params: [], headers: [pair('Accept', 'application/json')], body: '', bodyType: 'urlencoded', form, timeoutMs: source.timeoutMs, connection: source.connection, variables: source.variables, authMode: oauth.clientAuth === 'basic' ? 'basic' : 'none', basicAuth: oauth.clientAuth === 'basic' ? { username: formCredential(oauth.clientId), password: formCredential(oauth.clientSecret) } : undefined }
}
export function receivedToken(oauth: OAuth, response: Response): OAuth {
  if (response.status < 200 || response.status >= 300) throw new Error(`Token endpoint returned HTTP ${response.status}.`)
  let data: Record<string, unknown>
  try { data = JSON.parse(response.body) } catch { throw new Error('Token endpoint did not return valid JSON.') }
  if (!data || typeof data.access_token !== 'string' || !data.access_token.trim()) throw new Error('Token endpoint did not return access_token.')
  if (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) throw new Error('Token endpoint returned an unsupported token_type. Bearer tokens are required.')
  if (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token)) throw new Error('Token endpoint returned an invalid refresh_token.')
  if (data.expires_in !== undefined && (typeof data.expires_in !== 'number' && typeof data.expires_in !== 'string' || typeof data.expires_in === 'string' && !/^\d+(?:\.\d+)?$/.test(data.expires_in))) throw new Error('Token endpoint returned an invalid expires_in.')
  const expires = data.expires_in === undefined ? NaN : Number(data.expires_in)
  if (data.expires_in !== undefined && (!Number.isFinite(expires) || expires < 0)) throw new Error('Token endpoint returned an invalid expires_in.')
  return { ...oauth, accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : oauth.refreshToken, expiresAt: tokenExpiry(expires) }
}
export function oauthNeedsToken(oauth: OAuth): boolean { return !oauth.accessToken || oauth.expiresAt !== undefined && oauth.expiresAt <= Date.now() + 3000 }
export function oauthIdentity(oauth: OAuth): string {
  const { accessToken, refreshToken, expiresAt, autoRefresh, ...config } = oauth
  void accessToken; void refreshToken; void expiresAt; void autoRefresh
  const normalized = { ...config, clientAuth: config.clientAuth ?? 'body', flow: config.flow ?? 'client_credentials' }
  return JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right))))
}
// Serialize refreshes per resolved account so rotating refresh tokens are never spent twice.
export class OAuthTokenManager {
  private values = new Map<string, OAuth>()
  private aliases = new Map<string, string>()
  private refreshAccounts = new Map<string, string>()
  private queues = new Map<string, Promise<unknown>>()
  private generation = 0
  sameGrant(key: string, source: OAuth, candidate: OAuth): boolean {
    const seed = (oauth: OAuth) => JSON.stringify([key, oauth.accessToken, oauth.refreshToken ?? ''])
    const original = seed(source), current = seed(candidate)
    if (original === current) return true
    const account = this.aliases.get(original)
    return account !== undefined && this.aliases.get(current) === account
  }
  async ensure(key: string, source: OAuth, signal: AbortSignal, acquire: (current: OAuth) => Promise<OAuth>, force = false): Promise<OAuth> {
    const credentials = (oauth: OAuth) => JSON.stringify([key, oauth.accessToken, oauth.refreshToken ?? ''])
    const refreshGrant = (oauth: OAuth) => oauth.refreshToken ? JSON.stringify([key, oauth.refreshToken]) : undefined
    const seed = credentials(source), refresh = refreshGrant(source)
    const account = this.aliases.get(seed) ?? (refresh ? this.refreshAccounts.get(refresh) : undefined) ?? seed
    const signIn = force && source.flow === 'authorization_code'
    // Different access-token snapshots can still carry the same one-use refresh token.
    if (refresh && !signIn) this.refreshAccounts.set(refresh, account)
    const prior = this.queues.get(account) ?? Promise.resolve(), generation = this.generation
    const task = prior.catch(() => {}).then(async () => {
      signal.throwIfAborted()
      const cached = generation === this.generation ? this.values.get(account) : undefined
      const knownSnapshot = generation === this.generation && this.aliases.get(seed) === account
      // Honour a newly pasted valid access token, but never spend an already rotated refresh token again.
      const reusable = cached && (knownSnapshot || oauthNeedsToken(source) && cached.refreshToken !== source.refreshToken)
      // A fresh sign-in can select another user and must not retain their predecessor's refresh token.
      const current = signIn ? { ...source, accessToken: '', refreshToken: '', expiresAt: undefined } : reusable ? { ...source, accessToken: cached.accessToken, refreshToken: cached.refreshToken, expiresAt: cached.expiresAt } : source
      if (!force && !oauthNeedsToken(current)) return current
      const next = await acquire(current)
      signal.throwIfAborted()
      if (generation === this.generation) {
        const nextSeed = credentials(next), nextAccount = signIn ? nextSeed : account
        this.values.set(nextAccount, next)
        // Link both sides of a rotation, so queued sends and old runner snapshots use the latest grant.
        // Sign-ins only link the new grant: two empty request configurations can belong to different users.
        if (!signIn) { this.aliases.set(seed, nextAccount); if (refresh) this.refreshAccounts.set(refresh, nextAccount) }
        this.aliases.set(nextSeed, nextAccount)
        const nextRefresh = refreshGrant(next)
        if (nextRefresh) this.refreshAccounts.set(nextRefresh, nextAccount)
      }
      return next
    })
    this.queues.set(account, task)
    void task.finally(() => { if (this.queues.get(account) === task) this.queues.delete(account) }).catch(() => {})
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort() })
    try { return await Promise.race([task, aborted]) } finally { signal.removeEventListener('abort', onAbort) }
  }
  clear() { this.generation++; this.values.clear(); this.aliases.clear(); this.refreshAccounts.clear(); this.queues.clear() }
}

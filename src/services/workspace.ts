import type { Assertion, AssertionResult, AuthSettings, Collection, Cookie, Environment, Request, Response } from '../types/request'
import { authMode } from './requestOptions.ts'
import { normalizeRequestQuery } from './queryParams.ts'
import { parseExactJson, stringifyResponseValue } from './responseView.ts'
import { redactAuth, redactPairs, redactRequest } from './secretExport.ts'
import type { ExportOptions } from './secretExport.ts'
import { validatePostmanExport } from './importLimits.ts'

export function checkResponse(tests: Assertion[], response: Response): AssertionResult[] {
  return tests.filter(t => t.enabled).map(t => {
    let actual = ''; let passed = false
    try {
      if (t.kind === 'status') { actual = String(response.status); passed = actual === t.expected.trim() }
      if (t.kind === 'duration') { actual = `${response.duration} ms`; passed = Number.isFinite(Number(t.expected)) && response.duration <= Number(t.expected) }
      if (t.kind === 'contains') { actual = response.body; passed = actual.includes(t.expected) }
      if (t.kind === 'header') { actual = Object.entries(response.headers).find(([k]) => k.toLowerCase() === t.key.toLowerCase())?.[1] ?? ''; passed = actual === t.expected }
      if (t.kind === 'json') {
        let value: unknown = parseExactJson(response.body)
        for (const key of t.key.split('.').filter(Boolean)) {
          if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('JSON path not found')
          value = (value as Record<string, unknown>)[key]
        }
        actual = typeof value === 'string' ? value : stringifyResponseValue(value)
        passed = actual === t.expected
      }
    } catch (e) { actual = e instanceof Error ? e.message : String(e) }
    return { name: `${t.kind}${t.key ? `: ${t.key}` : ''} → ${t.expected}`, passed, actual: actual.slice(0, 300) }
  })
}

export const POSTMAN_ENVIRONMENT_MAX_BYTES = 1024 * 1024
export const POSTMAN_ENVIRONMENT_MAX_VARIABLES = 10000
export function importEnvironment(text: string): Environment {
  if (new TextEncoder().encode(text).length > POSTMAN_ENVIRONMENT_MAX_BYTES) throw new Error('Environment is too large. The maximum size is 1 MiB.')
  const data = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!data || typeof data.name !== 'string' || !Array.isArray(data.values)) throw new Error('Choose a Postman environment JSON with name and values.')
  if (data.values.length > POSTMAN_ENVIRONMENT_MAX_VARIABLES) throw new Error('Environment has too many variables. The maximum is 10,000.')
  const variables = data.values.map((value: unknown, index: number) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Environment variable ${index + 1} must be an object with a string key.`)
    const p = value as Record<string, unknown>
    if (typeof p.key !== 'string') throw new Error(`Environment variable ${index + 1} must have a string key.`)
    if (p.value !== undefined && p.value !== null && !['string', 'number', 'boolean'].includes(typeof p.value) || typeof p.value === 'number' && !Number.isFinite(p.value)) throw new Error(`Environment variable ${index + 1} must have a string, number, boolean or null value.`)
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new Error(`Environment variable ${index + 1} enabled must be true or false.`)
    if (p.secret !== undefined && typeof p.secret !== 'boolean') throw new Error(`Environment variable ${index + 1} secret must be true or false.`)
    return { id: crypto.randomUUID(), key: p.key, value: String(p.value ?? ''), enabled: p.enabled !== false, ...(p.type === 'secret' || p.secret === true ? { secret: true } : {}) }
  })
  return { id: crypto.randomUUID(), name: data.name, variables }
}
export function exportEnvironment(env: Environment, options: ExportOptions = {}) {
  const variables = options.includeSecrets ? env.variables : redactPairs(env.variables)!
  if (variables.length > POSTMAN_ENVIRONMENT_MAX_VARIABLES) throw new Error('Environment has too many variables. The maximum is 10,000.')
  const exported = { id: env.id, name: env.name, values: variables.map(p => ({ key: p.key, value: p.value, enabled: p.enabled, type: p.secret ? 'secret' : 'default' })), _postman_variable_scope: 'environment' }
  if (new TextEncoder().encode(JSON.stringify(exported, null, 2)).length > POSTMAN_ENVIRONMENT_MAX_BYTES) throw new Error('Environment export exceeds 1 MiB.')
  return exported
}
export function exportCollection(sourceCollection: Collection, requests: Request[], options: ExportOptions = {}) {
  const collection = options.includeSecrets ? sourceCollection : { ...redactAuth(sourceCollection), variables: redactPairs(sourceCollection.variables) }
  // Keep the original extension key compatible with existing exported collections.
  type Item = { name: string; item?: Item[]; request?: unknown; variable?: unknown; reqdesk?: unknown }
  const item: Item[] = []
  const pairs = (ps: Request['params']) => ps.map(p => ({ key: p.key, value: p.value, disabled: !p.enabled, ...(p.secret ? { secret: true } : {}) }))
  const variables = (ps: Request['params']) => ps.map(p => ({ key: p.key, value: p.value, disabled: !p.enabled, ...(p.secret ? { type: 'secret', secret: true } : {}) }))
  const postmanAuth = (auth: AuthSettings, fallback: 'none' | 'inherit') => {
    const mode = authMode(auth, fallback)
    return mode === 'inherit' ? undefined : mode === 'oauth' && auth.oauth ? { type: 'oauth2', oauth2: [{ key: 'accessToken', value: auth.oauth.accessToken }, { key: 'accessTokenUrl', value: auth.oauth.tokenUrl }, { key: 'clientId', value: auth.oauth.clientId }, { key: 'clientSecret', value: auth.oauth.clientSecret }, { key: 'scope', value: auth.oauth.scope }, { key: 'grant_type', value: auth.oauth.flow ?? 'client_credentials' }, { key: 'authUrl', value: auth.oauth.authorizationUrl ?? '' }, { key: 'redirect_uri', value: auth.oauth.redirectUri ?? '' }, { key: 'refreshToken', value: auth.oauth.refreshToken ?? '' }] } : mode === 'bearer' ? { type: 'bearer', bearer: [{ key: 'token', value: auth.bearerToken ?? '' }] } : mode === 'basic' && auth.basicAuth ? { type: 'basic', basic: Object.entries(auth.basicAuth).map(([key, value]) => ({ key, value })) } : mode === 'apikey' && auth.apiKey ? { type: 'apikey', apikey: Object.entries(auth.apiKey).map(([key, value]) => ({ key, value })) } : { type: 'noauth' }
  }
  const folder = (path: string) => {
    let children = item
    for (const part of path.split('/').map(s => s.trim()).filter(Boolean)) {
      let node = children.find(i => i.name === part && i.item)
      if (!node) { node = { name: part, item: [] }; children.push(node) }
      children = node.item!
    }
    return children
  }
  for (const path of collection.folders ?? []) folder(path)
  for (const source of requests.filter(r => r.collectionId === collection.id)) {
    const r = normalizeRequestQuery(options.includeSecrets ? source : redactRequest(source))
    const auth = postmanAuth(r, 'inherit')
    const body = r.bodyType === 'none' ? undefined : r.bodyType === 'urlencoded' ? { mode: 'urlencoded', urlencoded: pairs(r.form ?? []) } : r.bodyType === 'formdata' ? { mode: 'formdata', formdata: [...pairs(r.form ?? []).map(p => ({ ...p, type: 'text' })), ...(r.files ?? []).map(f => ({ key: f.key, type: 'file', src: f.name, disabled: !f.enabled }))] } : r.bodyType === 'binary' ? { mode: 'file', file: { src: r.binary?.name } } : { mode: 'raw', raw: r.body, options: { raw: { language: r.bodyType } } }
    folder(r.folder ?? '').push({ name: r.name, variable: variables(r.variables ?? []), request: { method: r.method, header: pairs(r.headers), url: { raw: r.url, query: pairs(r.params) }, auth, body }, reqdesk: { tests: r.tests, responseSchema: r.responseSchema, binary: r.binary, files: r.files, oauth: r.oauth, authMode: authMode(r), timeoutMs: r.timeoutMs, followRedirects: r.followRedirects, browserCookies: r.browserCookies, extractions: r.extractions, connection: r.connection } })
  }
  const exported = { info: { name: collection.name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, variable: variables(collection.variables ?? []), auth: postmanAuth(collection, 'none'), reqdesk: { oauth: collection.oauth }, item }
  validatePostmanExport(exported)
  return exported
}
export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = name.replace(/[<>:"/\\|?*]/g, '_') + '.json'; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const cookieControls = (text: string) => Array.from(text).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
export function validCookie(cookie: Cookie): boolean {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string' || typeof cookie.secure !== 'boolean' || typeof cookie.hostOnly !== 'boolean') return false
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || cookie.value.includes(';') || cookieControls(cookie.value) || !cookie.path.startsWith('/') || cookieControls(cookie.path)) return false
  if (cookie.expiresAt !== undefined && !Number.isFinite(cookie.expiresAt)) return false
  try {
    const domain = cookie.domain.toLowerCase()
    const parsed = new URL(`http://${domain}`)
    if (parsed.hostname !== domain || parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false
    return domain.startsWith('[') || domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) && label.length <= 63)
  } catch { return false }
}
export function cookiesFor(url: string, cookies: Cookie[], now = Date.now()): string {
  const u = new URL(url)
  return cookies.filter(c => validCookie(c) && (c.expiresAt === undefined || c.expiresAt > now) && (!c.secure || u.protocol === 'https:') && (u.hostname === c.domain.toLowerCase() || !c.hostOnly && u.hostname.endsWith('.' + c.domain.toLowerCase())) && (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/'))).sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ')
}
export function captureCookies(url: string, lines: string[], jar: Cookie[], now = Date.now()): Cookie[] {
  const u = new URL(url); let next = [...jar]
  for (const line of lines) {
    if (/[\r\n]/.test(line)) continue
    const [first, ...attributes] = line.split(';'); const eq = first.indexOf('='); if (eq <= 0) continue
    const attrs = new Map(attributes.map(s => { const i = s.indexOf('='); return [ (i < 0 ? s : s.slice(0, i)).trim().toLowerCase(), i < 0 ? '' : s.slice(i + 1).trim() ] }))
    const declaredDomain = (attrs.get('domain') ?? u.hostname).replace(/^\./, '').toLowerCase()
    if (u.hostname !== declaredDomain && !u.hostname.endsWith('.' + declaredDomain)) continue
    // Pin received cookies to the responding host. Broader subdomain scope is an explicit jar edit.
    const domain = u.hostname
    const defaultPath = u.pathname.slice(0, u.pathname.lastIndexOf('/')) || '/'
    const path = attrs.get('path')?.startsWith('/') ? attrs.get('path')! : defaultPath
    const maxAge = attrs.get('max-age') ?? ''
    const seconds = /^-?\d+$/.test(maxAge) ? Number(maxAge) : undefined
    const expires = seconds === undefined ? Date.parse(attrs.get('expires') ?? '') : seconds <= 0 ? now - 1 : Math.min(8640000000000000, now + seconds * 1000)
    const cookie: Cookie = { id: crypto.randomUUID(), name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim(), domain, path, secure: attrs.has('secure'), hostOnly: true, expiresAt: Number.isFinite(expires) ? expires : undefined }
    if (!validCookie(cookie)) continue
    next = next.filter(c => !(c.name === cookie.name && c.domain === domain && c.path === path))
    if (cookie.expiresAt === undefined || cookie.expiresAt > now) next.push(cookie)
  }
  return next
}

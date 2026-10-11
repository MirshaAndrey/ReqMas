import type { AuthSettings, Collection, ConnectionSettings, Method, OAuth, Pair, Request } from '../types/request'
import { CollectionImportBudget, validatePostmanItems } from './importLimits.ts'

export type ImportResult = { collection: Collection; requests: Request[]; warnings: string[]; skipped: number }
export const POSTMAN_IMPORT_MAX_BYTES = 50 * 1024 * 1024
export const POSTMAN_IMPORT_MAX_ITEMS = 10000
export const POSTMAN_IMPORT_MAX_DEPTH = 100
type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const str = (value: unknown): string => value == null ? '' : String(value)
const pair = (key: string, value: string, enabled = true): Pair => ({ id: crypto.randomUUID(), key, value, enabled })
const pairs = (value: unknown): Pair[] => list(value).map(object).map(p => ({ ...pair(str(p.key ?? p.id), str(p.value), p.disabled !== true), ...(p.type === 'secret' || p.secret === true ? { secret: true } : {}) }))
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
function parseAuth(value: unknown): AuthSettings {
  const a = object(value); const mode = str(a.type || 'noauth')
  const attributes = Object.fromEntries(list(a[mode]).map(object).map(p => [str(p.key), str(p.value)]))
  if (mode === 'basic') return { authMode: 'basic', basicAuth: { username: attributes.username || '', password: attributes.password || '' } }
  if (mode === 'bearer') return { authMode: 'bearer', bearerToken: attributes.token || '' }
  if (mode === 'apikey') return { authMode: 'apikey', apiKey: { key: attributes.key || '', value: attributes.value || '', in: attributes.in === 'query' ? 'query' : 'header' } }
  if (mode === 'oauth2') return { authMode: 'oauth', oauth: { tokenUrl: attributes.accessTokenUrl || '', clientId: attributes.clientId || '', clientSecret: attributes.clientSecret || '', scope: attributes.scope || '', accessToken: attributes.accessToken || '', ...(['authorization_code', 'authorization_code_with_pkce'].includes(attributes.grant_type || attributes.grantType) ? { flow: 'authorization_code' as const } : {}), ...(attributes.authUrl ? { authorizationUrl: attributes.authUrl } : {}), ...(attributes.redirect_uri || attributes.redirectUri ? { redirectUri: attributes.redirect_uri || attributes.redirectUri } : {}), ...(attributes.refreshToken ? { refreshToken: attributes.refreshToken } : {}) } }
  return { authMode: 'none' }
}

function oauthMetadata(base: OAuth | undefined, value: unknown, warn: (message: string) => void): OAuth | undefined {
  const extra = object(value)
  if (!Object.keys(extra).length) return base
  const next: OAuth = { tokenUrl: '', clientId: '', clientSecret: '', scope: '', accessToken: '', ...base }
  for (const key of ['tokenUrl', 'clientId', 'clientSecret', 'scope', 'accessToken', 'authorizationUrl', 'redirectUri', 'refreshToken'] as const) {
    if (extra[key] === undefined) continue
    if (typeof extra[key] === 'string') next[key] = extra[key]
    else warn(`Invalid Reqmas OAuth ${key} metadata was ignored.`)
  }
  if (extra.clientAuth !== undefined) { if (extra.clientAuth === 'basic' || extra.clientAuth === 'body') next.clientAuth = extra.clientAuth; else warn('Invalid Reqmas OAuth clientAuth metadata was ignored.') }
  if (extra.flow !== undefined) { if (extra.flow === 'authorization_code' || extra.flow === 'client_credentials') next.flow = extra.flow; else warn('Invalid Reqmas OAuth flow metadata was ignored.') }
  if (extra.autoRefresh !== undefined) { if (typeof extra.autoRefresh === 'boolean') next.autoRefresh = extra.autoRefresh; else warn('Invalid Reqmas OAuth autoRefresh metadata was ignored.') }
  if (extra.expiresAt !== undefined) { if (typeof extra.expiresAt === 'number' && Number.isFinite(extra.expiresAt) && extra.expiresAt >= 0 && extra.expiresAt <= 8640000000000000) next.expiresAt = extra.expiresAt; else warn('Invalid Reqmas OAuth expiresAt metadata was ignored.') }
  return next
}
function connectionMetadata(value: unknown, warn: (message: string) => void): ConnectionSettings | undefined {
  const source = object(value), result: ConnectionSettings = {}
  for (const key of ['proxyUrl', 'proxyUsername', 'proxyPassword', 'caPem', 'clientCertPem', 'clientKeyPem'] as const) {
    if (source[key] === undefined) continue
    if (typeof source[key] === 'string' && source[key].length <= 1024 * 1024) result[key] = source[key]
    else warn(`Invalid Reqmas connection ${key} metadata was ignored.`)
  }
  return Object.keys(result).length ? result : undefined
}

// Query fields are authoritative when Postman provides them separately from url.raw.
function urlParts(value: unknown): { url: string; params: Pair[]; variables: Pair[] } {
  const data = object(value)
  let raw = typeof value === 'string' ? value : str(data.raw)
  if (!raw) {
    const host = Array.isArray(data.host) ? data.host.map(str).join('.') : str(data.host)
    const path = Array.isArray(data.path) ? data.path.map(str).join('/') : str(data.path).replace(/^\//, '')
    raw = `${str(data.protocol) || 'https'}://${host}${data.port ? `:${str(data.port)}` : ''}${path ? `/${path}` : ''}`
  }
  const hashIndex = raw.indexOf('#')
  const fragment = hashIndex >= 0 ? raw.slice(hashIndex) : ''
  raw = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  const queryIndex = raw.indexOf('?')
  const rawParams = queryIndex >= 0 ? new URLSearchParams(raw.slice(queryIndex + 1)) : new URLSearchParams()
  const params = Array.isArray(data.query) ? pairs(data.query) : Array.from(rawParams, ([key, value]) => pair(key, value))
  const variables = pairs(data.variable)
  let url = (queryIndex >= 0 ? raw.slice(0, queryIndex) : raw) + fragment
  // URL path variables use :name in Postman; retain them as editable template variables.
  url = url.replace(/\/:([\w-]+)(?=\/|#|$)/g, '/{{$1}}')
  return { url, params, variables }
}

export function importPostman(text: string): ImportResult {
  if (new TextEncoder().encode(text).length > POSTMAN_IMPORT_MAX_BYTES) throw new Error('Collection is too large. The maximum size is 50 MiB, including embedded files.')
  let parsed: unknown
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new Error('Invalid JSON. Choose a Postman collection exported as JSON v2 or v2.1.') }
  const root = object(parsed)
  const info = object(root.info)
  if (!Array.isArray(root.item) || typeof info.name !== 'string') throw new Error('This is not a Postman v2/v2.1 collection. Export a collection, rather than an environment or workspace dump.')
  if (info.schema && !/\/v2\.(0|1)\.0\//.test(str(info.schema))) throw new Error('Unsupported collection version. Export JSON v2 or v2.1 from Postman.')
  // Validate folder limits iteratively before the recursive importer sees any items.
  validatePostmanItems(root.item)
  const collection: Collection = { id: crypto.randomUUID(), name: info.name.trim() || 'Imported collection', variables: pairs(root.variable), ...parseAuth(root.auth) }
  const result: ImportResult = { collection, requests: [], warnings: [], skipped: 0 }
  const warn = (name: string, message: string) => result.warnings.push(`${name}: ${message}`)
  collection.oauth = oauthMetadata(collection.oauth, object(root.reqdesk).oauth, message => warn(collection.name, message))
  const budget = new CollectionImportBudget(collection)
  const walk = (items: unknown[], path: string[], inheritedAuth: unknown, scoped: Pair[], depth: number) => {
    if (depth > POSTMAN_IMPORT_MAX_DEPTH) throw new Error('Collection folders are nested too deeply. The maximum is 100 folder levels.')
    for (const value of items) {
      const item = object(value)
      const name = [...path, str(item.name) || 'Untitled request'].join(' / ')
      const auth = item.auth == null ? inheritedAuth : item.auth
      const variables = [...scoped, ...pairs(item.variable)]
      if (list(item.event).length) warn(name, 'Postman scripts are not executed.')
      if (Array.isArray(item.item)) { const folder = [...path, str(item.name) || 'Folder']; budget.addFolder(folder.join('/')); collection.folders = [...(collection.folders ?? []), folder.join('/')]; walk(item.item, folder, auth, variables, depth + 1); continue }
      if (!item.request) { result.skipped++; warn(name, 'Missing request; skipped.'); continue }
      const source = typeof item.request === 'string' ? { url: item.request, method: 'GET' } : object(item.request)
      const method = str(source.method || 'GET').toUpperCase()
      if (!methods.includes(method)) { result.skipped++; warn(name, `Method ${method} is unsupported; skipped.`); continue }
      const body = object(source.body)
      if (body.disabled !== true && body.mode && !['raw', 'urlencoded', 'formdata', 'file'].includes(str(body.mode))) { result.skipped++; warn(name, `Body mode ${str(body.mode)} is unsupported; request skipped.`); continue }
      const effectiveAuth = source.auth == null ? auth : source.auth
      const authData = object(effectiveAuth)
      const authType = str(authData.type || 'noauth')
      if (!['noauth', 'bearer', 'basic', 'apikey', 'oauth2'].includes(authType)) { result.skipped++; warn(name, `Authentication ${authType} is unsupported; request skipped.`); continue }
      const { url, params, variables: urlVariables } = urlParts(source.url)
      let headers: Pair[]
      if (typeof source.header === 'string') {
        const lines = source.header.split(/\r?\n/).filter(Boolean)
        if (lines.some(line => line.indexOf(':') < 1)) { result.skipped++; warn(name, 'Malformed header; request skipped.'); continue }
        headers = lines.map(line => { const index = line.indexOf(':'); return pair(line.slice(0, index).trim(), line.slice(index + 1).trim()) })
      } else headers = pairs(source.header)
      const request: Request = { id: crypto.randomUUID(), collectionId: collection.id, name: str(item.name) || 'Untitled request', folder: path.join('/'), method: method as Method, url, params, headers, bodyType: 'none', body: '', variables: [...variables, ...urlVariables] }
      if (body.mode === 'raw' && body.disabled !== true) {
        request.body = str(body.raw)
        const language = object(object(body.options).raw).language
        request.bodyType = language === 'json' || headers.some(p => p.enabled && p.key.toLowerCase() === 'content-type' && p.value.includes('json')) ? 'json' : language === 'xml' ? 'xml' : 'text'
      }
      if (body.disabled !== true && body.mode === 'urlencoded') { request.bodyType = 'urlencoded'; request.form = pairs(body.urlencoded) }
      if (body.disabled !== true && body.mode === 'formdata') {
        request.bodyType = 'formdata'; request.form = pairs(list(body.formdata).filter(p => object(p).type !== 'file'))
      }
      const extra = object(item.reqdesk)
      if (typeof extra.timeoutMs === 'number' && Number.isFinite(extra.timeoutMs) && extra.timeoutMs >= 100 && extra.timeoutMs <= 300000) request.timeoutMs = extra.timeoutMs
      if (typeof extra.followRedirects === 'boolean') request.followRedirects = extra.followRedirects
      if (typeof extra.browserCookies === 'boolean') request.browserCookies = extra.browserCookies
      if (typeof extra.responseSchema === 'string') request.responseSchema = extra.responseSchema
      const connection = connectionMetadata(extra.connection, message => warn(name, message)); if (connection) request.connection = connection
      if (Array.isArray(extra.extractions)) request.extractions = list(extra.extractions).map(object).filter(t => ['json', 'header'].includes(str(t.source))).map(t => ({ id: crypto.randomUUID(), source: t.source as 'json' | 'header', path: str(t.path), variable: str(t.variable), enabled: t.enabled !== false }))
      if (Array.isArray(extra.tests)) request.tests = list(extra.tests).map(object).filter(t => ['status', 'duration', 'contains', 'header', 'json'].includes(str(t.kind))).map(t => ({ id: crypto.randomUUID(), kind: t.kind as NonNullable<Request['tests']>[number]['kind'], key: str(t.key), expected: str(t.expected), enabled: t.enabled !== false }))
      if (body.disabled !== true && body.mode === 'file') request.bodyType = 'binary'
      // Reqmas exports embed file bytes for local round trips; ordinary Postman exports do not.
      const fileBody = (v: unknown) => {
        const f = object(v)
        if (typeof f.base64 !== 'string') return undefined
        try {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)) throw new Error('Invalid base64 characters')
          atob(f.base64)
          return { name: str(f.name), type: str(f.type), base64: f.base64 }
        } catch { warn(name, `Embedded file ${str(f.name) || '(unnamed)'} has invalid base64; attach the file again.`); return undefined }
      }
      request.binary = fileBody(extra.binary)
      request.files = list(extra.files).map(object).flatMap(f => { const data = fileBody(f); return data ? [{ ...data, id: crypto.randomUUID(), key: str(f.key), enabled: f.enabled !== false }] : [] })
      if (request.bodyType === 'binary' && !request.binary) warn(name, 'Binary file needs to be attached in the Body tab.')
      if (request.bodyType === 'formdata' && list(body.formdata).filter(p => object(p).type === 'file' && object(p).disabled !== true).length > request.files.filter(f => f.enabled).length) warn(name, 'Attach local files again in the Body tab; Postman exports contain file paths only.')
      Object.assign(request, parseAuth(effectiveAuth))
      request.oauth = oauthMetadata(request.oauth, extra.oauth, message => warn(name, message))
      if (authType === 'oauth2') {
        if (!request.oauth?.accessToken) warn(name, 'OAuth 2.0: configure authorization or paste an access token before sending.')
      }
      if (authType === 'bearer') {
        request.headers = headers.filter(p => p.key.toLowerCase() !== 'authorization')
      }
      if (authType === 'apikey') {
        if (!request.apiKey?.key) { result.skipped++; warn(name, 'API key name is missing; skipped.'); continue }
      }
      if (source.auth == null && effectiveAuth === root.auth) request.authMode = 'inherit'
      if (['inherit', 'none', 'basic', 'bearer', 'oauth', 'apikey'].includes(str(extra.authMode))) request.authMode = extra.authMode as NonNullable<Request['authMode']>
      const dynamic = [url, request.body, ...request.headers.map(p => p.value), ...request.params.map(p => p.value)].join(' ')
      if (/\{\{\$/.test(dynamic)) warn(name, 'Dynamic Postman variables must be replaced with ordinary variable values.')
      budget.addRequest(request)
      result.requests.push(request)
    }
  }
  if (list(root.event).length) warn(collection.name, 'Collection scripts are not executed.')
  walk(root.item, [], root.auth, [], 0)
  return result
}

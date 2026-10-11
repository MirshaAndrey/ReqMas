import type { AuthSettings, Pair, Request, Response, WorkspaceData } from '../types/request'
import { changeRequestParams, queryRows } from './queryParams.ts'
import { isExactJsonNumber, parseExactJson, stringifyResponseValue } from './responseView.ts'

export type ExportOptions = { includeSecrets?: boolean }
const credentialHeader = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-key|x-auth-token|x-access-token)$/i
const credentialKey = /^(?:(?:access|refresh|id)[_-]?token|token|password|client[_-]?secret|api[_-]?key|code[_-]?verifier|client[_-]?key[_-]?pem)$/i
const redactCredential = (value: string): string => /^\{\{[^{}\r\n]+\}\}$/.test(value.trim()) ? value : ''
const redactHeaderCredential = (key: string, value: string): string => /^(?:authorization|proxy-authorization)$/i.test(key.trim()) && /^(?:Basic|Bearer)\s+\{\{[^{}\r\n]+\}\}$/i.test(value.trim()) ? value : redactCredential(value)

function redactJsonCredentials(body: string, allowTemplates = false): string {
  try {
    const value = parseExactJson(body), pending = [value]
    let changed = false
    while (pending.length) {
      const node = pending.pop()
      if (!node || typeof node !== 'object' || isExactJsonNumber(node)) continue
      for (const [key, entry] of Object.entries(node)) {
        if (credentialKey.test(key) && typeof entry === 'string' && entry) { (node as Record<string, unknown>)[key] = allowTemplates ? redactCredential(entry) : ''; changed = true }
        else if (entry && typeof entry === 'object') pending.push(entry)
      }
    }
    return changed ? stringifyResponseValue(value) : body
  } catch { return body }
}

export function redactPairs(rows: Pair[] | undefined): Pair[] | undefined {
  return rows?.map(row => row.secret ? { ...row, value: '' } : { ...row })
}
function withoutUrlPassword(text: string): string {
  try { const url = new URL(text); if (!url.password) return text; url.password = ''; return url.href }
  catch { return text }
}
export function redactAuth<T extends AuthSettings>(value: T): T {
  const next = structuredClone(value)
  if (next.basicAuth) next.basicAuth.password = redactCredential(next.basicAuth.password)
  if (next.bearerToken !== undefined) next.bearerToken = redactCredential(next.bearerToken)
  if (next.apiKey) next.apiKey.value = redactCredential(next.apiKey.value)
  if (next.oauth) {
    next.oauth.clientSecret = redactCredential(next.oauth.clientSecret); next.oauth.accessToken = redactCredential(next.oauth.accessToken)
    if (next.oauth.refreshToken !== undefined) next.oauth.refreshToken = redactCredential(next.oauth.refreshToken)
    delete next.oauth.expiresAt
    next.oauth.tokenUrl = withoutUrlPassword(next.oauth.tokenUrl)
    if (next.oauth.authorizationUrl) next.oauth.authorizationUrl = withoutUrlPassword(next.oauth.authorizationUrl)
  }
  return next
}
export function redactRequest(request: Request): Request {
  const next = redactAuth(request)
  for (const key of ['params', 'headers', 'form', 'variables'] as const) if (next[key]) next[key] = redactPairs(next[key])!
  next.params = redactPairs(queryRows(next))!
  next.params = next.params.map(pair => credentialKey.test(pair.key.trim()) ? { ...pair, value: redactCredential(pair.value) } : pair)
  const oauthForm = next.form?.some(pair => pair.key === 'grant_type' && ['client_credentials', 'authorization_code', 'refresh_token'].includes(pair.value))
  if (next.form) next.form = next.form.map(pair => credentialKey.test(pair.key.trim()) || oauthForm && pair.key === 'code' ? { ...pair, value: redactCredential(pair.value) } : pair)
  next.url = changeRequestParams(next, next.params).url
  next.headers = next.headers.map(pair => credentialHeader.test(pair.key.trim()) ? { ...pair, value: redactHeaderCredential(pair.key, pair.value) } : pair)
  next.url = withoutUrlPassword(next.url)
  if (next.bodyType === 'json') next.body = redactJsonCredentials(next.body, true)
  if (next.connection) {
    if (next.connection.proxyPassword !== undefined) next.connection.proxyPassword = redactCredential(next.connection.proxyPassword)
    if (next.connection.clientKeyPem !== undefined) next.connection.clientKeyPem = ''
    if (next.connection.proxyUrl) next.connection.proxyUrl = withoutUrlPassword(next.connection.proxyUrl)
  }
  return next
}
function redactHistoryResponse(response: Response): Response {
  const body = redactJsonCredentials(response.body)
  return { ...response, body, ...(body !== response.body ? { bodyBase64: undefined } : {}), headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, credentialHeader.test(key.trim()) ? '' : value])), setCookies: response.setCookies?.map(cookie => cookie.replace(/^([^=;]+)=([^;]*)/, '$1=')) }
}
export function redactWorkspace(data: WorkspaceData): WorkspaceData {
  const next = structuredClone(data)
  next.collections = next.collections.map(collection => ({ ...redactAuth(collection), variables: redactPairs(collection.variables) }))
  next.requests = next.requests.map(redactRequest)
  next.environments = next.environments.map(env => ({ ...env, variables: redactPairs(env.variables)! }))
  next.cookies = next.cookies.map(cookie => ({ ...cookie, value: '' }))
  next.trash.collections = next.trash.collections.map(collection => ({ ...redactAuth(collection), variables: redactPairs(collection.variables) }))
  next.trash.requests = next.trash.requests.map(redactRequest)
  next.history = next.history.map(history => ({ ...history, request: redactRequest(history.request), ...(history.response ? { response: redactHistoryResponse(history.response) } : {}) }))
  return next
}

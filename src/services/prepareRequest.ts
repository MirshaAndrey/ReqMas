import type { Pair, Request } from '../types/request'
import { queryRows, splitQueryUrl } from './queryParams.ts'
export class RequestValidationError extends Error {}

export function resolveVariables(input: string, variables: Pair[]): string {
  const values = new Map(variables.filter(v => v.enabled && v.key).map(v => [v.key, v.value]))
  const resolve = (text: string, stack: string[]): string => text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
    if (!values.has(key)) throw new RequestValidationError(`Variable "${key}" has no value. Set it in collection settings or the Variables tab.`)
    if (stack.includes(key) || stack.length >= 30) throw new RequestValidationError(`Circular variable reference: ${[...stack, key].join(' → ')}`)
    return resolve(values.get(key)!, [...stack, key])
  })
  return resolve(input, [])
}

export function prepareRequestUrl(request: Request, variables: Pair[]): URL {
  const resolve = (value: string) => resolveVariables(value, variables)
  const { base, fragment } = splitQueryUrl(request.url)
  let url: URL
  try { url = new URL(resolve(base + fragment)) } catch (e) { if (e instanceof RequestValidationError) throw e; throw new RequestValidationError('Enter a valid URL, including http:// or https://.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new RequestValidationError('Use an HTTP or HTTPS URL.')
  queryRows(request).filter(p => p.enabled && p.key).forEach(p => url.searchParams.append(resolve(p.key), resolve(p.value)))
  return url
}

export function prepareRequest(request: Request, collectionVariables: Pair[] = [], environmentVariables: Pair[] = []) {
  const variables = [...collectionVariables, ...environmentVariables, ...(request.variables ?? [])]
  const resolve = (value: string) => resolveVariables(value, variables)
  const url = prepareRequestUrl(request, variables)
  const headers = new Headers()
  for (const p of request.headers.filter(p => p.enabled && p.key)) {
    const key = resolve(p.key); const value = resolve(p.value)
    try { headers.set(key, value) } catch { throw new RequestValidationError('A header name or value is invalid. Check the Headers tab.') }
  }
  if (request.basicAuth) {
    const credential = `${resolve(request.basicAuth.username)}:${resolve(request.basicAuth.password)}`
    headers.set('Authorization', `Basic ${btoa(Array.from(new TextEncoder().encode(credential), b => String.fromCharCode(b)).join(''))}`)
  }
  if (request.bearerToken !== undefined) headers.set('Authorization', `Bearer ${resolve(request.bearerToken)}`)
  if (request.oauth) {
    if (!request.oauth.accessToken) throw new RequestValidationError('Get an OAuth access token in the Auth tab first.')
    if (request.oauth.expiresAt && request.oauth.expiresAt <= Date.now()) throw new RequestValidationError('OAuth token expired. Get a new token in the Auth tab.')
    headers.set('Authorization', `Bearer ${resolve(request.oauth.accessToken)}`)
  }
  if (request.apiKey) {
    const key = resolve(request.apiKey.key).trim()
    if (!key) throw new RequestValidationError('Enter an API key name in the Auth tab.')
    const value = resolve(request.apiKey.value)
    if (request.apiKey.in === 'query') { url.searchParams.delete(key); url.searchParams.append(key, value) }
    else { try { headers.set(key, value) } catch { throw new RequestValidationError('The API key header is invalid.') } }
  }
  const hasBody = !['GET', 'HEAD'].includes(request.method) && request.bodyType !== 'none'
  let body = hasBody && ['json', 'text', 'xml'].includes(request.bodyType) ? resolve(request.body) : undefined
  let bodyBase64: string | undefined
  if (hasBody && request.bodyType === 'urlencoded') {
    const form = new URLSearchParams()
    for (const p of request.form ?? []) if (p.enabled && p.key) form.append(resolve(p.key), resolve(p.value))
    body = form.toString()
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/x-www-form-urlencoded')
  }
  if (hasBody && request.bodyType === 'binary') {
    if (!request.binary) throw new RequestValidationError('Choose a binary file in the Body tab.')
    body = undefined; bodyBase64 = request.binary.base64
    if (!headers.has('Content-Type')) headers.set('Content-Type', request.binary.type || 'application/octet-stream')
  }
  if (hasBody && request.bodyType === 'formdata') {
    const boundary = `Reqmas${crypto.randomUUID().replaceAll('-', '')}`
    const chunks: Uint8Array[] = []
    const text = (s: string) => chunks.push(new TextEncoder().encode(s))
    const quote = (s: string) => s.replace(/[\r\n]/g, '').replaceAll('"', '%22')
    for (const p of request.form ?? []) if (p.enabled && p.key) text(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(resolve(p.key))}"\r\n\r\n${resolve(p.value)}\r\n`)
    for (const f of request.files ?? []) if (f.enabled && f.key) {
      text(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(resolve(f.key))}"; filename="${quote(f.name)}"\r\nContent-Type: ${f.type.replace(/[\r\n]/g, '') || 'application/octet-stream'}\r\n\r\n`)
      chunks.push(Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))); text('\r\n')
    }
    text(`--${boundary}--\r\n`)
    bodyBase64 = chunks.map(c => Array.from(c, b => String.fromCharCode(b)).join('')).join('')
    bodyBase64 = btoa(bodyBase64); body = undefined
    headers.set('Content-Type', `multipart/form-data; boundary=${boundary}`)
  }
  if (hasBody && request.bodyType === 'json') {
    try { JSON.parse(body!) } catch { throw new RequestValidationError('Invalid JSON body. Check quotes, commas, and brackets in the Body tab.') }
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  }
  if (hasBody && request.bodyType === 'text' && !headers.has('Content-Type')) headers.set('Content-Type', 'text/plain;charset=UTF-8')
  if (hasBody && request.bodyType === 'xml' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/xml')
  return { url: url.toString(), method: request.method, headers: Object.fromEntries(headers.entries()), body, bodyBase64 }
}

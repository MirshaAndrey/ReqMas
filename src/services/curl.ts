import type { Method, Pair, Request } from '../types/request'
import { prepareRequest, resolveVariables } from './prepareRequest.ts'
import { requestTimeout } from './requestOptions.ts'
import { normalizeRequestQuery, splitQueryUrl } from './queryParams.ts'

const pair = (key: string, value: string): Pair => ({ id: crypto.randomUUID(), key, value, enabled: true })
// Parse shell quoting as text. Never execute commands, expand variables or read files.
export function curlTokens(input: string): string[] {
  const tokens: string[] = []; let word = ''; let started = false; let quote = ''; let ansi = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quote) {
      if (c === quote) { quote = ''; ansi = false; continue }
      if (c === '\\' && (quote === '"' || ansi)) {
        const next = input[++i]; if (next === undefined) throw new Error('Incomplete cURL escape')
        if (quote === '"' && (next === '\n' || next === '\r' && input[i + 1] === '\n')) { if (next === '\r') i++; continue }
        word += ansi ? ({ n: '\n', r: '\r', t: '\t' }[next] ?? next) : ['"', '\\', '$', '`'].includes(next) ? next : '\\' + next
      } else word += c
    } else if (['\\', '^', '`'].includes(c) && (input[i + 1] === '\n' || input[i + 1] === '\r' && input[i + 2] === '\n')) { i += input[i + 1] === '\r' ? 2 : 1 }
    else if (/\s/.test(c)) { if (started) { tokens.push(word); word = ''; started = false } }
    else if (c === '"' || c === "'") { quote = c; started = true }
    else if (c === '$' && input[i + 1] === "'") { quote = "'"; ansi = true; started = true; i++ }
    else if (c === '\\') { const next = input[++i]; if (next === undefined) throw new Error('Incomplete cURL escape'); word += next; started = true }
    else if ([';', '|', '&', '<', '>', '`'].includes(c) || c === '$' && input[i + 1] === '(') throw new Error('Paste one cURL command without shell operators or substitutions')
    else { word += c; started = true }
  }
  if (quote) throw new Error('Unclosed quote in cURL command')
  if (started) tokens.push(word)
  return tokens
}
export function importCurl(input: string, collectionId: string): Request {
  const tokens = curlTokens(input.trim())
  if (!/^(curl|curl\.exe)$/i.test(tokens.shift() ?? '')) throw new Error('Start the command with curl or curl.exe')
  const request: Request = { id: crypto.randomUUID(), collectionId, name: 'Imported cURL', method: 'GET', url: '', headers: [], params: [], bodyType: 'none', body: '', authMode: 'none', followRedirects: false }
  const data: string[] = []; let explicitMethod = ''; let asQuery = false; let json = false; let form = false; let head = false
  const appendData = (body: string, concatenate = false) => data.push((data.length && !concatenate ? '&' : '') + body)
  for (let i = 0; i < tokens.length; i++) {
    let option = tokens[i]; let inline: string | undefined
    if (option.startsWith('--') && option.includes('=')) { const at = option.indexOf('='); inline = option.slice(at + 1); option = option.slice(0, at) }
    else if (/^-[XHduAbeFm]/.test(option) && option.length > 2) { inline = option.slice(2); option = option.slice(0, 2) }
    const value = () => { const result = inline ?? tokens[++i]; if (result === undefined) throw new Error(`Missing value for ${option}`); return result }
    if (option === '--url' || !option.startsWith('-')) { const url = option === '--url' ? value() : option; if (request.url) throw new Error('Only one request URL is supported'); request.url = url }
    else if (['-X', '--request'].includes(option)) explicitMethod = value().toUpperCase()
    else if (['-H', '--header'].includes(option)) { const header = value(); const at = header.indexOf(':'); if (at < 1) throw new Error('Headers must use Name: value'); request.headers.push(pair(header.slice(0, at).trim(), header.slice(at + 1).trim())) }
    else if (['-d', '--data', '--data-raw', '--data-binary', '--json'].includes(option)) { const body = value(); if (body.startsWith('@') && option !== '--data-raw') throw new Error('File references are not read. Attach the file in the Body tab.'); appendData(body, option === '--json'); if (option === '--json') json = true }
    else if (option === '--data-urlencode') { const field = value(); const at = field.indexOf('='); if (field.startsWith('@') || at < 1) throw new Error('Use --data-urlencode name=value'); appendData(`${field.slice(0, at)}=${encodeURIComponent(field.slice(at + 1))}`) }
    else if (['-F', '--form', '--form-string'].includes(option)) { const field = value(); const at = field.indexOf('='); if (at < 1) throw new Error('Form fields must use name=value'); const content = field.slice(at + 1); if (option !== '--form-string' && /^[<@]/.test(content)) throw new Error('Attach multipart files in the Body tab after importing.'); request.form = [...(request.form ?? []), pair(field.slice(0, at), content)]; form = true }
    else if (['-u', '--user'].includes(option)) { const credentials = value(); const at = credentials.indexOf(':'); request.basicAuth = { username: at < 0 ? credentials : credentials.slice(0, at), password: at < 0 ? '' : credentials.slice(at + 1) }; request.authMode = 'basic' }
    else if (['-b', '--cookie'].includes(option)) { const cookie = value(); if (!cookie.includes('=')) throw new Error('Cookie files are not read. Use a Cookie header or workspace cookies.'); request.headers.push(pair('Cookie', cookie)) }
    else if (['-A', '--user-agent', '-e', '--referer'].includes(option)) request.headers.push(pair(['-A', '--user-agent'].includes(option) ? 'User-Agent' : 'Referer', value()))
    else if (['-I', '--head'].includes(option)) head = true
    else if (['-G', '--get'].includes(option)) asQuery = true
    else if (['-L', '--location'].includes(option)) request.followRedirects = true
    else if (option === '--max-time' || option === '-m') { const seconds = Number(value()); if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 300) throw new Error('Timeout must be between 0.1 and 300 seconds'); request.timeoutMs = Math.round(seconds * 1000) }
    else if (!['--compressed', '-s', '-S', '-sS', '--silent', '--show-error', '-i', '--include'].includes(option)) throw new Error(`Unsupported cURL option: ${option}`)
  }
  if (!request.url) throw new Error('The command has no request URL')
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
  const method = explicitMethod || (head ? 'HEAD' : asQuery ? 'GET' : data.length || form ? 'POST' : 'GET')
  if (!methods.includes(method)) throw new Error(`Unsupported HTTP method: ${method}`)
  request.method = method as Method
  if (form && data.length) throw new Error('Use either form fields or raw data in one request')
  if (asQuery && form) throw new Error('cURL --get cannot import multipart form fields as a query body')
  if (!asQuery && (data.length || form) && ['GET', 'HEAD'].includes(method)) throw new Error(`Reqmas does not send a ${method} request body. Use --get for query data or change the method.`)
  if (asQuery) request.params = Array.from(new URLSearchParams(data.join('')), ([key, value]) => pair(key, value))
  else if (form) request.bodyType = 'formdata'
  else if (data.length) {
    request.body = data.join('')
    const contentType = request.headers.findLast(header => header.key.toLowerCase() === 'content-type')
    request.bodyType = (contentType ? /json/i.test(contentType.value) : json) ? 'json' : 'text'
    if (!contentType) request.headers.push(pair('Content-Type', json ? 'application/json' : 'application/x-www-form-urlencoded'))
    if (json && !request.headers.some(header => header.key.toLowerCase() === 'accept')) request.headers.push(pair('Accept', 'application/json'))
  }
  const inlineParams = Array.from(new URLSearchParams(splitQueryUrl(request.url).query), ([key, value]) => pair(key, value))
  return normalizeRequestQuery({ ...request, params: [...inlineParams, ...request.params] })
}
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
export function exportCurl(request: Request, collectionVariables: Pair[] = [], environmentVariables: Pair[] = []): string {
  const prepared = prepareRequest(request, collectionVariables, environmentVariables)
  const multipartFields = request.bodyType === 'formdata' && (request.form?.some(p => p.enabled && p.key) || request.files?.some(f => f.enabled && f.key))
  const inferredPost = request.method === 'POST' && (prepared.body !== undefined || prepared.bodyBase64 !== undefined)
  const parts = ['curl', ...(request.method === 'HEAD' ? ['--head'] : inferredPost ? [] : ['--request', request.method]), shellQuote(prepared.url), '--max-time', String(requestTimeout(request) / 1000)]
  if (request.followRedirects !== false) parts.push('--location')
  for (const [key, value] of Object.entries(prepared.headers)) if (!(multipartFields && key === 'content-type')) parts.push('--header', shellQuote(`${key}: ${value}`))
  if (prepared.body !== undefined) parts.push('--data-raw', shellQuote(prepared.body))
  else if (prepared.bodyBase64 !== undefined) {
    if (request.bodyType === 'binary') parts.push('--data-binary', shellQuote('@' + request.binary!.name))
    else if (!multipartFields) parts.push('--data-raw', shellQuote(atob(prepared.bodyBase64)))
    else {
      // Resolve text fields using the same variable priority as the request.
      const textRequest = { ...request, bodyType: 'urlencoded' as const, files: undefined }
      const fields = new URLSearchParams(prepareRequest(textRequest, collectionVariables, environmentVariables).body)
      for (const [key, value] of fields) parts.push('--form-string', shellQuote(`${key}=${value}`))
      for (const file of request.files ?? []) if (file.enabled && file.key) parts.push('--form', shellQuote(`${resolveVariables(file.key, [...collectionVariables, ...environmentVariables, ...(request.variables ?? [])])}=@${file.name};type=${file.type || 'application/octet-stream'}`))
    }
  }
  return parts.join(' ')
}

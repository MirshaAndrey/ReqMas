import type { Response } from '../types/request'

export const RESPONSE_JSON_LIMIT = 2 * 1024 * 1024
const exactNumber = Symbol('Exact JSON number')
type ExactNumber = { [exactNumber]: { raw: string; canonical: string } }
export function isExactJsonNumber(value: unknown): value is ExactNumber { return value !== null && typeof value === 'object' && exactNumber in value }
function canonicalNumber(raw: string): string {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw)!
  const fraction = parts[3] ?? '', digits = (parts[2] + fraction).replace(/^0+/, '')
  if (!digits) return '0'
  // Bound arithmetic for pathological exponents while retaining their original text.
  if ((parts[4]?.length ?? 0) > 128) return raw
  const significant = digits.replace(/0+$/, '')
  const exponent = BigInt(parts[4] ?? 0) - BigInt(fraction.length) + BigInt(digits.length - significant.length)
  return `${parts[1]}${significant}e${exponent}`
}
function jsonTokens(source: string): string[] { return source.match(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g) ?? [] }
function markerPrefix(value: unknown): string {
  const strings: string[] = [], pending: unknown[] = [value]
  while (pending.length) { const node = pending.pop(); if (typeof node === 'string') strings.push(node); else if (node !== null && typeof node === 'object' && !isExactJsonNumber(node)) for (const [key, child] of Object.entries(node)) { strings.push(key); pending.push(child) } }
  let prefix = '__REQMAS_EXACT_NUMBER_'
  while (strings.some(text => text.includes(prefix))) prefix += '_'
  return prefix
}
export function parseExactJson(source: string): unknown {
  const value: unknown = JSON.parse(source)
  const replacements = new Map<string, ExactNumber>()
  const prefix = markerPrefix(value)
  const encoded = jsonTokens(source).map(token => {
    if (!/^-?\d/.test(token)) return token
    const number = Number(token), canonical = canonicalNumber(token)
    if (Number.isFinite(number) && canonicalNumber(JSON.stringify(number)) === canonical && !(number === 0 && token.startsWith('-'))) return token
    const marker = prefix + replacements.size
    replacements.set(marker, { [exactNumber]: { raw: token, canonical } })
    return JSON.stringify(marker)
  }).join('')
  if (!replacements.size) return value
  const parsed: unknown = JSON.parse(encoded)
  if (typeof parsed === 'string' && replacements.has(parsed)) return replacements.get(parsed)
  const pending: unknown[] = [parsed]
  while (pending.length) {
    const node = pending.pop()
    if (node === null || typeof node !== 'object') continue
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string' && replacements.has(child)) (node as Record<string, unknown>)[key] = replacements.get(child)
      else pending.push(child)
    }
  }
  return parsed
}
export function stringifyResponseValue(value: unknown): string {
  if (isExactJsonNumber(value)) return value[exactNumber].raw
  const prefix = markerPrefix(value), replacements: string[] = []
  const serialized = JSON.stringify(value, (_, child: unknown) => {
    if (!isExactJsonNumber(child)) return child
    replacements.push(child[exactNumber].raw)
    return `${prefix}${replacements.length - 1}`
  }) ?? 'null'
  return serialized.replace(new RegExp(`"${prefix}(\\d+)"`, 'g'), (_, index: string) => replacements[Number(index)])
}
export function formatResponseJson(source: string): string {
  JSON.parse(source)
  const tokens = jsonTokens(source), output: string[] = []
  let depth = 0
  const newline = () => output.push('\n' + '  '.repeat(Math.min(depth, 64)))
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '{' || token === '[') { output.push(token); depth++; if (tokens[i + 1] !== '}' && tokens[i + 1] !== ']') newline() }
    else if (token === '}' || token === ']') { depth--; if (tokens[i - 1] !== '{' && tokens[i - 1] !== '[') newline(); output.push(token) }
    else if (token === ',') { output.push(token); newline() }
    else if (token === ':') output.push(': ')
    else output.push(token)
  }
  return output.join('')
}
export function responseHeader(response: Response, name: string): string {
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? ''
}
export function responseMediaType(response: Response): string { return responseHeader(response, 'content-type').split(';')[0].trim().toLowerCase() }
export function parseResponseJson(response: Response): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (response.binary) return { ok: false, reason: 'This response contains binary data.' }
  if (response.bodyTruncated) return { ok: false, reason: 'The history snapshot is incomplete. Send the request again to inspect the full JSON.' }
  if (response.body.length > RESPONSE_JSON_LIMIT) return { ok: false, reason: 'JSON tree and formatting are limited to 2 MB. Use Raw or save the full response.' }
  try { return { ok: true, value: parseExactJson(response.body) } } catch { return { ok: false, reason: 'The response body is not valid JSON.' } }
}
export function responseKind(response: Response): string {
  const media = responseMediaType(response)
  if (response.binary) return media.startsWith('image/') ? 'IMAGE' : media === 'application/pdf' ? 'PDF' : 'BINARY'
  if (media === 'application/json' || media.endsWith('+json')) return 'JSON'
  if (media.includes('xml')) return 'XML'
  if (media === 'text/html') return 'HTML'
  return 'TEXT'
}
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])
export function responseImageSource(response: Response): string | undefined {
  const media = responseMediaType(response)
  if (!imageTypes.has(media) || !response.bodyBase64 || response.bodyTruncated || response.bodyBase64.length > 8 * 1024 * 1024) return undefined
  return `data:${media};base64,${response.bodyBase64}`
}
export function responseBytes(response: Response): Uint8Array<ArrayBuffer> {
  if (response.bodyTruncated) throw new Error('This history snapshot is incomplete. Send the request again to save the full file.')
  if (response.bodyBase64 !== undefined) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.bodyBase64)) throw new Error('The response bytes are not valid base64.')
    const raw = atob(response.bodyBase64)
    return Uint8Array.from(raw, ch => ch.charCodeAt(0))
  }
  if (response.binary) throw new Error('Original binary bytes are unavailable in this history entry. Send the request again.')
  return new TextEncoder().encode(response.body)
}
const extensions: Record<string, string> = { 'application/json': 'json', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/html': 'html', 'application/xml': 'xml', 'text/xml': 'xml', 'text/csv': 'csv', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp' }
export function responseFileName(response: Response): string {
  const disposition = responseHeader(response, 'content-disposition')
  let name = ''
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"\r\n]*)"|([^;\r\n]*))/i.exec(disposition)
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\\r\n])*)"|([^;\r\n]*))/i.exec(disposition)
  if (encoded) {
    const raw = (encoded[1] ?? encoded[2]).trim()
    const utf8 = /^UTF-8'[^']*'(.*)$/i.exec(raw)
    if (utf8) { try { name = decodeURIComponent(utf8[1]) } catch { /* Fall back to filename or URL. */ } }
  }
  if (!name && plain) name = (plain[1] ?? plain[2]).replace(/\\(["\\])/g, '$1').trim()
  if (!name && response.url) { try { const segment = new URL(response.url).pathname.split('/').filter(Boolean).at(-1); if (segment) name = decodeURIComponent(segment) } catch { /* Use a generated filename. */ } }
  const extension = extensions[responseMediaType(response)] ?? (responseMediaType(response).endsWith('+json') ? 'json' : response.binary ? 'bin' : 'txt')
  // A server filename is a label, never a local path.
  name = name.split(/[\\/]/).at(-1)!.replace(/[<>:"|?*]|\p{Cc}/gu, '_').replace(/[.\s]+$/g, '').trim()
  if (!name || /^\.+$/.test(name)) name = `response.${extension}`
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`
  if (!name.includes('.')) name += `.${extension}`
  if (name.length > 180) { const dot = name.lastIndexOf('.'); const suffix = dot > 0 && name.length - dot <= 15 ? name.slice(dot) : `.${extension}`; name = name.slice(0, 180 - suffix.length) + suffix }
  return name
}
export function jsonPointer(parent: string, key: string): string { return `${parent}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}` }
export function valueSummary(value: unknown, limit = 180): string {
  const raw = isExactJsonNumber(value) ? value[exactNumber].raw : value === null ? 'null' : Array.isArray(value) ? `[${value.length} items]` : typeof value === 'object' ? `{${Object.keys(value).length} keys}` : JSON.stringify(value) ?? String(value)
  return raw.length > limit ? raw.slice(0, limit) + '…' : raw
}
export type JsonTreeRow = { path: string; key: string; value: unknown; depth: number; expandable: boolean; expanded: boolean }
export function flattenJsonTree(value: unknown, expanded: ReadonlySet<string>, limit = 1000, maxDepth = 64, offset = 0): { rows: JsonTreeRow[]; truncated: boolean; hasMore: boolean } {
  const rows: JsonTreeRow[] = []
  type Frame = { path: string; key: string; value: unknown; depth: number; keys?: string[]; index?: number }
  const stack: Frame[] = [{ path: '', key: '$', value, depth: 0 }]
  let truncated = false
  let visible = 0
  while (stack.length) {
    const node = stack[stack.length - 1]
    if (node.keys) {
      if (node.index! >= node.keys.length) { stack.pop(); continue }
      const key = node.keys[node.index!++]
      stack.push({ path: jsonPointer(node.path, key), key, value: (node.value as Record<string, unknown>)[key], depth: node.depth + 1 })
      continue
    }
    const keys = node.value !== null && typeof node.value === 'object' && !isExactJsonNumber(node.value) ? Object.keys(node.value) : []
    const expandable = keys.length > 0
    const isExpanded = expandable && expanded.has(node.path)
    if (visible++ >= offset) { if (rows.length >= limit) return { rows, truncated: true, hasMore: true }; rows.push({ path: node.path, key: node.key, value: node.value, depth: node.depth, expandable, expanded: isExpanded }) }
    if (!isExpanded || node.depth >= maxDepth) { if (isExpanded) truncated = true; stack.pop(); continue }
    node.keys = keys; node.index = 0
  }
  return { rows, truncated, hasMore: false }
}
export type ResponseDifference = { kind: 'added' | 'removed' | 'changed'; path: string; before?: unknown; after?: unknown }
export type ResponseComparison = { kind: 'json' | 'text' | 'binary'; changes: ResponseDifference[]; truncated: boolean; equal: boolean; error?: string }
export function diffResponses(before: Response, after: Response, limit = 200): ResponseComparison {
  if (before.bodyTruncated || after.bodyTruncated) return { kind: 'text', changes: [], truncated: true, equal: false, error: 'An incomplete history snapshot cannot be compared reliably. Send the request again.' }
  if (before.binary || after.binary) {
    if (before.bodyBase64 === undefined || after.bodyBase64 === undefined) return { kind: 'binary', changes: [], truncated: false, equal: false, error: 'Original bytes are required to compare binary responses.' }
    try {
      const a = responseBytes(before), b = responseBytes(after)
      const equal = a.length === b.length && a.every((byte, i) => byte === b[i])
      return { kind: 'binary', equal, truncated: false, changes: equal ? [] : [{ kind: 'changed', path: '/', before: `${a.length} bytes`, after: `${b.length} bytes` }] }
    } catch (e) { return { kind: 'binary', changes: [], truncated: false, equal: false, error: e instanceof Error ? e.message : 'Unable to compare binary bytes.' } }
  }
  const a = parseResponseJson(before), b = parseResponseJson(after)
  const changes: ResponseDifference[] = []
  if (a.ok && b.ok) {
    const stack: { path: string; a: unknown; b: unknown; hasA: boolean; hasB: boolean }[] = [{ path: '', a: a.value, b: b.value, hasA: true, hasB: true }]
    let visited = 0
    let truncated = false
    while (stack.length && changes.length < limit && visited++ < 10000) {
      const node = stack.pop()!
      if (!node.hasA || !node.hasB) { changes.push({ kind: node.hasA ? 'removed' : 'added', path: node.path, ...(node.hasA ? { before: node.a } : { after: node.b }) }); continue }
      if (Object.is(node.a, node.b)) continue
      const numberA = isExactJsonNumber(node.a) ? node.a[exactNumber].canonical : typeof node.a === 'number' ? canonicalNumber(JSON.stringify(node.a)) : undefined
      const numberB = isExactJsonNumber(node.b) ? node.b[exactNumber].canonical : typeof node.b === 'number' ? canonicalNumber(JSON.stringify(node.b)) : undefined
      if (numberA !== undefined && numberA === numberB) continue
      const bothArrays = Array.isArray(node.a) && Array.isArray(node.b)
      const bothObjects = node.a !== null && node.b !== null && typeof node.a === 'object' && typeof node.b === 'object' && !Array.isArray(node.a) && !Array.isArray(node.b) && !isExactJsonNumber(node.a) && !isExactJsonNumber(node.b)
      if (bothArrays || bothObjects) {
        const x = node.a as Record<string, unknown>, y = node.b as Record<string, unknown>
        const keys = bothArrays ? Array.from({ length: Math.max((node.a as unknown[]).length, (node.b as unknown[]).length) }, (_, i) => String(i)) : [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()
        const available = Math.max(0, 10000 - visited - stack.length)
        if (keys.length > available) truncated = true
        for (let i = Math.min(keys.length, available) - 1; i >= 0; i--) { const key = keys[i]; stack.push({ path: jsonPointer(node.path, key), a: x[key], b: y[key], hasA: Object.hasOwn(x, key), hasB: Object.hasOwn(y, key) }) }
      } else changes.push({ kind: 'changed', path: node.path, before: node.a, after: node.b })
    }
    truncated ||= stack.length > 0
    return { kind: 'json', changes, truncated, equal: !truncated && changes.length === 0 }
  }
  if (before.body === after.body) return { kind: 'text', changes: [], truncated: false, equal: true }
  const oldLines = before.body.split('\n'), newLines = after.body.split('\n')
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let oldEnd = oldLines.length, newEnd = newLines.length
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd-- }
  const changedCount = Math.max(oldEnd - prefix, newEnd - prefix)
  for (let i = 0; i < Math.min(limit, changedCount); i++) {
    const hasA = prefix + i < oldEnd, hasB = prefix + i < newEnd
    changes.push({ kind: hasA && hasB ? 'changed' : hasA ? 'removed' : 'added', path: `Line ${prefix + i + 1}`, ...(hasA ? { before: oldLines[prefix + i] } : {}), ...(hasB ? { after: newLines[prefix + i] } : {}) })
  }
  return { kind: 'text', changes, truncated: changedCount > limit, equal: false }
}

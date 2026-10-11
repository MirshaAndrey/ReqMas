import type { AssertionResult, Environment, Extraction, History, Pair, Response } from '../types/request'
import { parseExactJson, stringifyResponseValue } from './responseView.ts'

export function responseValue(response: Response, source: Extraction['source'], path: string): string {
  if (source === 'header') {
    const found = Object.entries(response.headers).find(([key]) => key.toLowerCase() === path.trim().toLowerCase())
    if (!found) throw new Error(`Header "${path}" was not found`)
    return found[1]
  }
  if (response.bodyTruncated) throw new Error('The response body is incomplete. Send the request again before capturing JSON values.')
  let value: unknown = parseExactJson(response.body)
  for (const key of path.trim().replace(/^\$\.?/, '').split('.').filter(Boolean)) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`JSON path "${path}" was not found`)
    value = (value as Record<string, unknown>)[key]
  }
  if (value === null || typeof value === 'object') return stringifyResponseValue(value)
  return String(value)
}
export function captureVariables(rules: Extraction[], response: Response, environment?: Environment): { variables?: Pair[]; results: AssertionResult[] } {
  const enabled = rules.filter(rule => rule.enabled)
  if (!enabled.length) return { results: [] }
  const updates = new Map<string, string>()
  const results = enabled.map(rule => {
    try {
      if (!environment) throw new Error('Choose an active environment before capturing variables')
      if (response.status < 200 || response.status >= 300) throw new Error('Capture requires a successful 2xx response')
      if (!rule.variable.trim()) throw new Error('Enter a destination variable name')
      updates.set(rule.variable.trim(), responseValue(response, rule.source, rule.path))
      return { name: `Capture ${rule.variable}`, passed: true, actual: `Saved to ${environment.name}` }
    } catch (e) { return { name: `Capture ${rule.variable || 'variable'}`, passed: false, actual: e instanceof Error ? e.message : String(e) } }
  })
  if (results.some(result => !result.passed)) return { results: results.map(result => result.passed ? { ...result, passed: false, actual: 'No variables saved because another capture rule failed' } : result) }
  const variables = environment!.variables.map(variable => updates.has(variable.key) ? { ...variable, value: updates.get(variable.key)!, enabled: true } : variable)
  for (const [key, value] of updates) if (!variables.some(variable => variable.key === key)) variables.push({ id: crypto.randomUUID(), key, value, enabled: true })
  return { variables, results }
}
// Keep response snapshots bounded without losing the original size/status metadata.
export function appendHistory(entry: History, history: History[]): History[] {
  let budget = 1024 * 1024
  return [entry, ...history].slice(0, 100).map(item => {
    if (!item.response) return item
    const bytes = new TextEncoder().encode(item.response.body)
    const raw = item.response.bodyBase64
    const rawSize = raw ? Math.floor(raw.length * 3 / 4) - (raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0) : 0
    const limit = Math.min(budget, 100 * 1024)
    if (bytes.length + rawSize <= limit) {
      budget -= bytes.length + rawSize
      return item
    }
    const body = new TextDecoder().decode(bytes.slice(0, limit), { stream: bytes.length > limit })
    budget -= new TextEncoder().encode(body).length
    return { ...item, response: { ...item.response, body, bodyBase64: undefined, bodyTruncated: true }, bodyTruncated: true }
  })
}

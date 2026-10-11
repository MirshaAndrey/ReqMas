import type { Pair } from '../types/request'
import { isExactJsonNumber, parseExactJson, stringifyResponseValue } from './responseView.ts'

export type RunnerDataset = { format: 'csv' | 'json'; columns: string[]; rows: Record<string, string>[] }
export const RUNNER_MAX_ROWS = 100
export const RUNNER_MAX_BYTES = 1024 * 1024

function csvRecords(text: string): string[][] {
  const records: string[][] = []
  let row: string[] = [], field = '', quoted = false, closed = false, started = false
  const endField = () => { row.push(field); field = ''; closed = false }
  const endRecord = () => { if (started || row.length) { endField(); records.push(row) }; row = []; field = ''; closed = false; started = false }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') { quoted = false; closed = true }
      else field += char
      continue
    }
    if (char === '"') {
      if (field || closed) throw new Error(`Unexpected quote in CSV record ${records.length + 1}. Quote the entire cell and escape quotes as "".`)
      quoted = true; started = true
    } else if (char === ',') { endField(); started = true }
    else if (char === '\r' || char === '\n') { endRecord(); if (char === '\r' && text[i + 1] === '\n') i++ }
    else { if (closed) throw new Error(`Unexpected character after a quoted CSV cell in record ${records.length + 1}.`); field += char; started = true }
  }
  if (quoted) throw new Error('Unclosed quoted CSV cell. Close the quote or escape an embedded quote as "".')
  endRecord()
  return records
}

function keyNames(keys: string[]): string[] {
  const columns = keys.map(key => key.trim())
  if (columns.some(key => !key || /[{}\r\n]/.test(key))) throw new Error('Variable names must be nonempty and cannot contain braces or line breaks.')
  if (new Set(columns).size !== columns.length) throw new Error('Dataset variable names must be unique after trimming spaces.')
  if (columns.length > 100) throw new Error('A dataset can contain at most 100 variable columns.')
  return columns
}

export function parseRunnerData(input: string, requestedFormat: 'auto' | 'csv' | 'json' = 'auto'): RunnerDataset {
  if (new TextEncoder().encode(input).length > RUNNER_MAX_BYTES) throw new Error('Dataset is too large. The maximum size is 1 MiB.')
  const text = input.replace(/^\uFEFF/, '')
  if (!text.trim()) throw new Error('Paste a CSV with a header row or a JSON array of objects.')
  const format = requestedFormat === 'auto' ? /^\s*[[{]/.test(text) ? 'json' : 'csv' : requestedFormat
  let columns: string[], rows: Record<string, string>[]
  if (format === 'csv') {
    const records = csvRecords(text)
    if (!records.length) throw new Error('CSV needs a header row with variable names.')
    columns = keyNames(records[0])
    rows = records.slice(1).map((record, index) => {
      if (record.length !== columns.length) throw new Error(`CSV data row ${index + 1} has ${record.length} cells; expected ${columns.length}.`)
      return Object.fromEntries(columns.map((key, i) => [key, record[i]]))
    })
  } else {
    let parsed: unknown
    try { parsed = parseExactJson(text) } catch (error) { throw new Error(`Invalid JSON dataset: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
    if (!Array.isArray(parsed)) throw new Error('JSON dataset must be an array of objects, one object per iteration.')
    columns = []
    rows = parsed.map((row: unknown, index: number) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error(`JSON row ${index + 1} must be an object.`)
      const entries = Object.entries(row)
      const keys = keyNames(entries.map(([key]) => key))
      for (const key of keys) if (!columns.includes(key)) columns.push(key)
      return Object.fromEntries(entries.map(([, value], i) => {
        if (isExactJsonNumber(value)) return [keys[i], stringifyResponseValue(value)]
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`JSON row ${index + 1}, "${keys[i]}": use a string, number, boolean or null; encode nested objects as strings.`)
        return [keys[i], typeof value === 'string' ? value : JSON.stringify(value)]
      }))
    })
    if (columns.length > 100) throw new Error('A dataset can contain at most 100 variable columns.')
  }
  if (!rows.length) throw new Error('Dataset needs at least one data row.')
  if (rows.length > RUNNER_MAX_ROWS) throw new Error(`Dataset has ${rows.length} rows; the maximum is ${RUNNER_MAX_ROWS}. Split it into smaller files.`)
  if (!columns.length) throw new Error('Dataset needs at least one named variable.')
  return { format, columns, rows }
}

export function runnerIterationVariables(row: Record<string, string>): Pair[] {
  return Object.entries(row).map(([key, value]) => ({ id: `dataset:${key}`, key, value, enabled: true }))
}

export class RunnerTimeoutError extends Error {
  constructor(timeoutMs: number) { super(`Timed out after ${timeoutMs} ms`); this.name = 'RunnerTimeoutError' }
}
export function executeRunnerRequest<T>(execute: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
  const request = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  let cancel: () => void
  const result = new Promise<T>((resolve, reject) => {
    cancel = () => { request.abort(); reject(new DOMException('Cancelled', 'AbortError')) }
    signal.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => { request.abort(); reject(new RunnerTimeoutError(timeoutMs)) }, timeoutMs)
    void Promise.resolve().then(() => {
      if (request.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      return execute(request.signal)
    }).then(resolve, reject)
  })
  return result.finally(() => { clearTimeout(timer); signal.removeEventListener('abort', cancel) })
}
export function runnerDelay(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, delayMs)
    signal.addEventListener('abort', done, { once: true })
  })
}

import type { Pair, Request } from '../types/request'
import { parseRunnerData, RUNNER_MAX_BYTES, RUNNER_MAX_ROWS, runnerIterationVariables } from './runnerData.ts'

export type RunnerScenario = {
  version: 1
  id: string
  name: string
  collectionId: string
  requestIds: string[]
  iterations: number
  delayMs: number
  stopOnFailure: boolean
  datasetText: string
  datasetFormat: 'auto' | 'csv' | 'json'
}
export const RUNNER_MAX_SCENARIOS = 100
export const RUNNER_MAX_EXECUTIONS = 10000
export type RunnerTask = { id: string; request: Request; iteration: number; datasetRow?: number; variables?: Pair[] }
export type RunnerTaskResult = { taskId: string; passed: boolean; cancelled?: boolean; attempt: number }

/** Missing references stay in saved scenarios so deleting/restoring a request is reversible. */
export function orderedRunnerRequests(requests: Request[], collectionId: string, requestIds: string[]): { requests: Request[]; missingIds: string[] } {
  const available = new Map(requests.filter(request => request.collectionId === collectionId).map(request => [request.id, request]))
  const ids = [...new Set(requestIds)]
  return { requests: ids.flatMap(id => available.has(id) ? [available.get(id)!] : []), missingIds: ids.filter(id => !available.has(id)) }
}

export function moveRunnerRequest(ids: string[], id: string, direction: -1 | 1): string[] {
  const next = [...ids], index = next.indexOf(id), target = index + direction
  if (index < 0 || target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function validateRunnerScenarios(value: unknown): RunnerScenario[] {
  const invalid = (detail: string): never => { throw new Error(`Invalid workspace backup: runnerScenarios.${detail}`) }
  if (!Array.isArray(value) || value.length > RUNNER_MAX_SCENARIOS) invalid(`maximum ${RUNNER_MAX_SCENARIOS} scenarios`)
  const ids = new Set<string>()
  return (value as unknown[]).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid(String(index))
    const s = entry as Record<string, unknown>, at = `${index}.`
    if (s.version !== 1) invalid(at + 'version')
    for (const key of ['id', 'name', 'collectionId']) if (typeof s[key] !== 'string' || !(s[key] as string).trim() || (s[key] as string).length > (key === 'name' ? 200 : 1000)) invalid(at + key)
    if (ids.has(s.id as string)) invalid(at + 'duplicate ID')
    ids.add(s.id as string)
    if (!Array.isArray(s.requestIds) || s.requestIds.length > 10000 || s.requestIds.some(id => typeof id !== 'string' || !id || id.length > 1000) || new Set(s.requestIds).size !== s.requestIds.length) invalid(at + 'requestIds')
    if (!Number.isInteger(s.iterations) || Number(s.iterations) < 1 || Number(s.iterations) > RUNNER_MAX_ROWS) invalid(at + 'iterations')
    if (!Number.isInteger(s.delayMs) || Number(s.delayMs) < 0 || Number(s.delayMs) > 60000) invalid(at + 'delayMs')
    if (typeof s.stopOnFailure !== 'boolean') invalid(at + 'stopOnFailure')
    if (!['auto', 'csv', 'json'].includes(s.datasetFormat as string)) invalid(at + 'datasetFormat')
    if (typeof s.datasetText !== 'string' || s.datasetText.length > RUNNER_MAX_BYTES || new TextEncoder().encode(s.datasetText as string).length > RUNNER_MAX_BYTES) invalid(at + 'datasetText exceeds 1 MiB')
    if ((s.datasetText as string).trim()) {
      try { parseRunnerData(s.datasetText as string, s.datasetFormat as RunnerScenario['datasetFormat']) }
      catch { invalid(at + 'datasetText is not a valid dataset') }
    }
    return structuredClone(s) as RunnerScenario
  })
}

export function uniqueRunnerScenarioName(name: string, scenarios: RunnerScenario[], exceptId?: string): string {
  const base = name.trim().slice(0, 200) || 'Runner scenario'
  const names = new Set(scenarios.filter(s => s.id !== exceptId).map(s => s.name.trim().toLocaleLowerCase()))
  if (!names.has(base.toLocaleLowerCase())) return base
  let suffix = 2
  while (names.has(`${base.slice(0, 190)} (${suffix})`.toLocaleLowerCase())) suffix++
  return `${base.slice(0, 190)} (${suffix})`
}

/** A task identifies an occurrence, not just a request ID: each row/iteration can fail independently. */
export function createRunnerTasks(requests: Request[], iterations: number, rows?: Record<string, string>[]): RunnerTask[] {
  const total = rows?.length ?? iterations
  if (!Number.isInteger(total) || total < 1 || total > RUNNER_MAX_ROWS) throw new Error(`Use 1–${RUNNER_MAX_ROWS} iterations.`)
  if (total * requests.length > RUNNER_MAX_EXECUTIONS) throw new Error(`A run can contain at most ${RUNNER_MAX_EXECUTIONS.toLocaleString('en-US')} executions. Select fewer requests or iterations.`)
  const snapshots = structuredClone(requests), data = rows ? structuredClone(rows) : undefined
  return Array.from({ length: total }, (_, iteration) => snapshots.map((request, index) => ({ id: `${iteration + 1}:${index}:${request.id}`, request, iteration: iteration + 1, ...(data ? { datasetRow: iteration + 1, variables: runnerIterationVariables(data[iteration]) } : {}) }))).flat()
}

export function failedRunnerTasks(tasks: RunnerTask[], results: RunnerTaskResult[]): RunnerTask[] {
  const latest = new Map(results.map(result => [result.taskId, result]))
  return tasks.filter(task => { const result = latest.get(task.id); return result && !result.passed && !result.cancelled })
}

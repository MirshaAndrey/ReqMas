import { useEffect, useMemo, useRef, useState } from 'react'
import type { Collection, Pair, Request, Response } from '../types/request'
import { checkResponse, downloadJson } from '../services/workspace'
import { Modal } from './Modal'
import { requestTimeout } from '../services/requestOptions'
import { executeRunnerRequest, parseRunnerData, RUNNER_MAX_BYTES, RUNNER_MAX_ROWS, runnerDelay } from '../services/runnerData'
import { createRunnerTasks, failedRunnerTasks, moveRunnerRequest, orderedRunnerRequests, RUNNER_MAX_EXECUTIONS, RUNNER_MAX_SCENARIOS, uniqueRunnerScenarioName } from '../services/runnerScenarios'
import type { RunnerScenario, RunnerTask, RunnerTaskResult } from '../services/runnerScenarios'
import { validateResponseSchema } from '../services/schemaValidation'
import '../runner.css'

type RunResult = RunnerTaskResult & { request: string; requestId: string; iteration: number; datasetRow?: number; status?: number; duration?: number; tests: ReturnType<typeof checkResponse>; error?: string }
type RunMetadata = { environment: string; collectionId: string; collectionName: string; scenario?: string; dataset?: { format: string; rows: number; columns: string[] } }
type Props = { collections: Collection[]; requests: Request[]; environmentName: string; scenarios?: RunnerScenario[]; onScenarios?: (scenarios: RunnerScenario[]) => void; initialCollectionId?: string; onExecute: (request: Request, signal: AbortSignal, iterationVariables?: Pair[]) => Promise<Response>; onBusy: (busy: boolean) => void; onClose: () => void }

export function CollectionRunner(p: Props) {
  const initialCollection = p.collections.some(collection => collection.id === p.initialCollectionId) ? p.initialCollectionId! : p.collections[0]?.id ?? ''
  const [collectionId, setCollectionId] = useState(initialCollection)
  const [requestIds, setRequestIds] = useState(() => p.requests.filter(request => request.collectionId === initialCollection).map(request => request.id))
  const [iterations, setIterations] = useState(1), [delay, setDelay] = useState(0), [stop, setStop] = useState(false)
  const [running, setRunning] = useState(false), [results, setResults] = useState<RunResult[]>([]), [lastTasks, setLastTasks] = useState<RunnerTask[]>([])
  const [runStatus, setRunStatus] = useState('Ready'), [runMetadata, setRunMetadata] = useState<RunMetadata>()
  const [datasetText, setDatasetText] = useState(''), [datasetFormat, setDatasetFormat] = useState<RunnerScenario['datasetFormat']>('auto')
  const [fileName, setFileName] = useState(''), [fileError, setFileError] = useState(''), [loading, setLoading] = useState(false)
  const [scenarioId, setScenarioId] = useState(''), [scenarioName, setScenarioName] = useState(''), [scenarioNotice, setScenarioNotice] = useState('')
  const [deletedScenario, setDeletedScenario] = useState<{ scenario: RunnerScenario; index: number }>()
  const abort = useRef<AbortController | null>(null), fileInput = useRef<HTMLInputElement>(null), fileRead = useRef(0)
  const onBusy = p.onBusy
  useEffect(() => () => { fileRead.current++; abort.current?.abort(); onBusy(false) }, [onBusy])
  const scenarios = p.scenarios ?? []
  const collectionRequests = p.requests.filter(request => request.collectionId === collectionId)
  const selection = orderedRunnerRequests(p.requests, collectionId, requestIds)
  const displayRequests = [...selection.requests, ...collectionRequests.filter(request => !requestIds.includes(request.id))]
  const retryTasks = failedRunnerTasks(lastTasks, results)
  const parsed = useMemo(() => {
    if (!datasetText.trim()) return {}
    try { return { data: parseRunnerData(datasetText, datasetFormat) } }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  }, [datasetText, datasetFormat])
  const dataset = parsed.data
  const executionCount = (dataset?.rows.length ?? iterations) * selection.requests.length
  const runError = selection.missingIds.length ? `${selection.missingIds.length} selected request(s) are unavailable. Restore them or remove missing requests before running.` : executionCount > RUNNER_MAX_EXECUTIONS ? `Select fewer requests or iterations: a run allows ${RUNNER_MAX_EXECUTIONS.toLocaleString('en-US')} executions.` : ''
  const loadFile = async (file?: File) => {
    if (!file) return
    const read = ++fileRead.current
    setLoading(true); setFileError('')
    try {
      if (file.size > RUNNER_MAX_BYTES) throw new Error('Dataset is too large. The maximum size is 1 MiB.')
      const text = await file.text()
      if (read !== fileRead.current) return
      setDatasetText(text); setFileName(file.name); setDatasetFormat(file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv')
    } catch (error) { if (read === fileRead.current) setFileError(error instanceof Error ? error.message : String(error)) }
    finally { if (read === fileRead.current) setLoading(false); if (fileInput.current) fileInput.current.value = '' }
  }
  const clearData = () => { fileRead.current++; setDatasetText(''); setFileName(''); setFileError(''); setLoading(false); setDatasetFormat('auto') }
  const chooseCollection = (id: string) => { setCollectionId(id); setRequestIds(p.requests.filter(request => request.collectionId === id).map(request => request.id)); setScenarioId(''); setScenarioNotice('') }
  const loadScenario = (id: string) => {
    setScenarioId(id); setScenarioNotice('')
    const scenario = scenarios.find(item => item.id === id)
    if (!scenario) { setScenarioName(''); return }
    fileRead.current++; setLoading(false); setFileError(''); setFileName('')
    setScenarioName(scenario.name); setCollectionId(scenario.collectionId); setRequestIds([...scenario.requestIds]); setIterations(scenario.iterations); setDelay(scenario.delayMs); setStop(scenario.stopOnFailure); setDatasetText(scenario.datasetText); setDatasetFormat(scenario.datasetFormat)
    setScenarioNotice(`Loaded ${scenario.name}.`)
  }
  const saveScenario = (copy = false) => {
    if (!p.onScenarios || loading || parsed.error || fileError || !collectionId || !requestIds.length || runError) return
    const existing = !copy && scenarios.find(item => item.id === scenarioId)
    if (!existing && scenarios.length >= RUNNER_MAX_SCENARIOS) { setScenarioNotice(`You can save up to ${RUNNER_MAX_SCENARIOS} scenarios.`); return }
    const scenario: RunnerScenario = { version: 1, id: existing ? existing.id : crypto.randomUUID(), name: uniqueRunnerScenarioName(scenarioName || p.collections.find(collection => collection.id === collectionId)?.name || 'Runner scenario', scenarios, existing ? existing.id : undefined), collectionId, requestIds: [...requestIds], iterations, delayMs: delay, stopOnFailure: stop, datasetText, datasetFormat }
    try { p.onScenarios(existing ? scenarios.map(item => item.id === existing.id ? scenario : item) : [...scenarios, scenario]); setScenarioId(scenario.id); setScenarioName(scenario.name); setScenarioNotice(`Saved ${scenario.name}.`) }
    catch (error) { setScenarioNotice(error instanceof Error ? error.message : String(error)) }
  }
  const deleteScenario = () => {
    const index = scenarios.findIndex(item => item.id === scenarioId)
    if (index < 0 || !p.onScenarios) return
    try { p.onScenarios(scenarios.filter(item => item.id !== scenarioId)); setDeletedScenario({ scenario: scenarios[index], index }); setScenarioId(''); setScenarioNotice(`Deleted ${scenarios[index].name}. You can undo this while the runner is open.`) }
    catch (error) { setScenarioNotice(error instanceof Error ? error.message : String(error)) }
  }
  const undoDelete = () => {
    if (!deletedScenario || !p.onScenarios) return
    if (scenarios.length >= RUNNER_MAX_SCENARIOS) { setScenarioNotice(`You can save up to ${RUNNER_MAX_SCENARIOS} scenarios.`); return }
    const next = [...scenarios], restored = { ...deletedScenario.scenario, name: uniqueRunnerScenarioName(deletedScenario.scenario.name, scenarios) }
    next.splice(Math.min(deletedScenario.index, next.length), 0, restored)
    try { p.onScenarios(next); setDeletedScenario(undefined); setScenarioNotice(`Restored ${restored.name}.`) }
    catch (error) { setScenarioNotice(error instanceof Error ? error.message : String(error)) }
  }
  const run = async (retry = false) => {
    if (abort.current || running || (!retry && (loading || parsed.error || fileError || runError))) return
    const tasks = retry ? retryTasks : createRunnerTasks(selection.requests, iterations, dataset?.rows)
    if (!tasks.length) return
    const previousAttempts = new Map(results.map(result => [result.taskId, result.attempt]))
    if (!retry) { setLastTasks(tasks); setResults([]); setRunMetadata({ environment: p.environmentName, collectionId, collectionName: p.collections.find(collection => collection.id === collectionId)?.name ?? 'Unavailable collection', scenario: scenarios.find(item => item.id === scenarioId)?.name, dataset: dataset ? { format: dataset.format, rows: dataset.rows.length, columns: [...dataset.columns] } : undefined }) }
    const controller = new AbortController()
    abort.current = controller; setRunning(true); p.onBusy(true); setRunStatus(retry ? 'Retrying failures…' : 'Running…')
    let failedStop = false
    try {
      for (let index = 0; index < tasks.length; index++) {
        if (controller.signal.aborted) break
        const task = tasks[index], request = task.request
        let result: RunResult
        setRunStatus(`${retry ? 'Retrying' : 'Running'} ${index + 1}/${tasks.length} · ${request.name} · iteration ${task.iteration}`)
        const identity = { taskId: task.id, requestId: request.id, request: request.name, iteration: task.iteration, datasetRow: task.datasetRow, attempt: retry ? (previousAttempts.get(task.id) ?? 1) + 1 : 1 }
        try {
          const response = await executeRunnerRequest(signal => p.onExecute(structuredClone(request), signal, task.variables ? structuredClone(task.variables) : undefined), controller.signal, requestTimeout(request))
          controller.signal.throwIfAborted()
          const tests = [...checkResponse(request.tests ?? [], response), ...(response.captures ?? []), ...validateResponseSchema(request.responseSchema, response)]
          result = { ...identity, status: response.status, duration: response.duration, passed: response.status < 400 && tests.every(test => test.passed), tests }
        } catch (error) {
          result = { ...identity, passed: false, cancelled: controller.signal.aborted, tests: [], error: controller.signal.aborted ? 'Cancelled' : error instanceof Error ? error.message : String(error) }
        }
        setResults(previous => retry ? previous.map(item => item.taskId === task.id ? result : item) : [...previous, result])
        if (stop && !result.passed) { failedStop = true; break }
        if (controller.signal.aborted) break
        if (delay > 0 && index < tasks.length - 1) await runnerDelay(controller.signal, delay)
      }
    } finally { setRunStatus(controller.signal.aborted ? 'Cancelled' : failedStop ? 'Stopped on failure' : 'Completed'); setRunning(false); p.onBusy(false); abort.current = null }
  }
  return <Modal title="Collection runner" wide onClose={() => { if (!running) p.onClose() }}>
    <p>Runs saved requests in your chosen order. Environment: {p.environmentName || 'None'}. HTTP 4xx/5xx, assertions and JSON Schema failures mark a request as failed.</p>
    <div className="runner-scenarios">
      <div className="field-grid"><label>Saved scenario<select disabled={running || loading} aria-label="Runner scenario" value={scenarioId} onChange={event => loadScenario(event.target.value)}><option value="">New / unsaved scenario</option>{scenarios.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}</select></label><label>Scenario name<input disabled={running} maxLength={200} aria-label="Runner scenario name" value={scenarioName} placeholder="Smoke tests" onChange={event => setScenarioName(event.target.value)} /></label></div>
      <div className="runner-scenario-actions"><button className="save" disabled={running || loading || !!parsed.error || !!fileError || !!runError || !requestIds.length || !p.onScenarios} onClick={() => saveScenario()}>{scenarioId ? 'Save scenario changes' : 'Save scenario'}</button>{scenarioId && <><button className="save" disabled={running || loading || !!parsed.error || !!fileError || !!runError} onClick={() => saveScenario(true)}>Save as new scenario</button><button className="danger-button" disabled={running} onClick={deleteScenario}>Delete scenario</button></>}{deletedScenario && <button className="save" disabled={running} onClick={undoDelete}>Undo scenario deletion</button>}</div>
      <p className="config-hint">Scenarios save collection, selected requests, order, settings and dataset in this workspace and its backup. Edit the name and save changes to rename.</p>
      {scenarioNotice && <p className="runner-scenario-notice" role="status">{scenarioNotice}</p>}
    </div>
    <div className="field-grid runner-settings">
      <label>Collection<select disabled={running} aria-label="Runner collection" value={collectionId} onChange={event => chooseCollection(event.target.value)}>{!p.collections.some(collection => collection.id === collectionId) && collectionId && <option value={collectionId}>Unavailable collection</option>}{p.collections.map(collection => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></label>
      <label>Iterations<input disabled={running || !!dataset} type="number" min={1} max={RUNNER_MAX_ROWS} aria-label="Runner iterations" value={dataset?.rows.length ?? iterations} onChange={event => setIterations(Math.max(1, Math.min(RUNNER_MAX_ROWS, Math.floor(Number(event.target.value)) || 1)))} /></label>
      <label>Delay between requests (ms)<input disabled={running} type="number" min={0} max={60000} value={delay} onChange={event => setDelay(Math.max(0, Math.min(60000, Math.floor(Number(event.target.value)) || 0)))} /></label>
    </div>
    <details className="runner-dataset" open={!!datasetText || !!fileError || loading}>
      <summary>Iteration data · {dataset ? `${dataset.rows.length} rows, ${dataset.columns.length} variables` : 'CSV or JSON (optional)'}</summary>
      <p className="config-hint">Each row runs the selected requests once. Use {'{{columnName}}'} in requests. Priority: collection → environment → dataset → request variables. Save a scenario to keep its data.</p>
      <div className="tool-row">
        <label className="runner-file">Load CSV / JSON<input ref={fileInput} disabled={running || loading} type="file" accept=".csv,.json,text/csv,application/json" aria-label="Runner dataset file" onChange={event => void loadFile(event.target.files?.[0])} /></label>
        <select disabled={running || loading} aria-label="Runner dataset format" value={datasetFormat} onChange={event => setDatasetFormat(event.target.value as RunnerScenario['datasetFormat'])}><option value="auto">Auto detect</option><option value="csv">CSV</option><option value="json">JSON</option></select>
        <button className="save" disabled={running || (!datasetText && !fileError && !loading)} onClick={clearData}>Clear data</button>
        {(fileName || loading) && <span>{loading ? 'Reading file…' : fileName}</span>}
      </div>
      <textarea className="runner-data-input" aria-label="Runner dataset" placeholder={'id,name\n1,Alice\n2,Bob\n\nOr: [{"id":1,"name":"Alice"}]'} spellCheck={false} disabled={running || loading} value={datasetText} onChange={event => { setDatasetText(event.target.value); setFileName(''); setFileError('') }} />
      {(parsed.error || fileError) && <p className="danger-text runner-data-error" role="alert">{fileError || parsed.error}</p>}
      {dataset && <div className="runner-data-preview"><table><thead><tr><th>Row</th>{dataset.columns.map(key => <th key={key}>{key}</th>)}</tr></thead><tbody>{dataset.rows.slice(0, 5).map((row, index) => <tr key={index}><td>{index + 1}</td>{dataset.columns.map(key => <td key={key} title={row[key]}>{Object.hasOwn(row, key) ? row[key] || '(empty)' : '—'}</td>)}</tr>)}</tbody></table></div>}
      <p className="config-hint">CSV supports quoted commas, doubled quotes and multiline cells. JSON uses objects with scalar values. Missing JSON fields keep environment values; empty strings override them. Up to {RUNNER_MAX_ROWS} rows and 1 MiB. Preview shows five rows.</p>
    </details>
    <label className="check-label"><input disabled={running} type="checkbox" checked={stop} onChange={event => setStop(event.target.checked)} /> Stop on first failure</label>
    <div className="runner-selection-tools"><button className="save" disabled={running || !collectionRequests.length} onClick={() => setRequestIds([...selection.requests.map(request => request.id), ...collectionRequests.filter(request => !requestIds.includes(request.id)).map(request => request.id)])}>Select all</button><button className="save" disabled={running || !requestIds.length} onClick={() => setRequestIds([])}>Select none</button>{selection.missingIds.length > 0 && <button className="save" disabled={running} onClick={() => setRequestIds(selection.requests.map(request => request.id))}>Remove missing requests</button>}<span>{selection.requests.length} selected · {executionCount} executions</span></div>
    {runError && <p className="danger-text runner-data-error" role="alert">{runError}</p>}
    <div className="runner-requests">{displayRequests.map(request => { const order = requestIds.indexOf(request.id); return <div className="runner-request-row" key={request.id}><label className="check-label"><input disabled={running} type="checkbox" aria-label={`Run ${request.name}`} checked={order >= 0} onChange={event => setRequestIds(ids => event.target.checked ? [...ids, request.id] : ids.filter(id => id !== request.id))} /><span className={`method ${request.method.toLowerCase()}`}>{request.method}</span><span>{request.folder ? request.folder + ' / ' : ''}{request.name}</span></label>{order >= 0 && <div className="runner-order"><span>{order + 1}</span><button type="button" aria-label={`Move ${request.name} up`} disabled={running || order === 0} onClick={() => setRequestIds(ids => moveRunnerRequest(ids, request.id, -1))}>↑</button><button type="button" aria-label={`Move ${request.name} down`} disabled={running || order === requestIds.length - 1} onClick={() => setRequestIds(ids => moveRunnerRequest(ids, request.id, 1))}>↓</button></div>}</div> })}</div>
    {runMetadata && results.length > 0 && <p className="config-hint">Results from {runMetadata.collectionName}{runMetadata.scenario ? ` · ${runMetadata.scenario}` : ''} · Environment: {runMetadata.environment || 'None'}.</p>}
    <div className="runner-summary" role="status">{runStatus} · {results.filter(result => result.passed).length} passed · {results.filter(result => !result.passed && !result.cancelled).length} failed · {results.filter(result => result.cancelled).length} cancelled</div>
    <div className="runner-results">{results.map(result => <details key={result.taskId} className={result.passed ? 'status-good' : 'status-bad'}><summary>{result.passed ? '✓' : result.cancelled ? '−' : '×'} #{result.iteration} {result.request} · {result.status ?? (result.cancelled ? 'Cancelled' : 'Error')} · {result.duration ?? '—'} ms{result.datasetRow ? ` · Data row ${result.datasetRow}` : ''}{result.attempt > 1 ? ` · Attempt ${result.attempt}` : ''}</summary>{result.error && <p>{result.error}</p>}{result.tests.map((test, testIndex) => <p key={testIndex}>{test.passed ? '✓' : '×'} {test.name} · {test.actual}</p>)}</details>)}</div>
    {!!retryTasks.length && <p className="config-hint">Retry uses the original request snapshots and dataset rows. Cancelled requests and unexecuted requests are excluded.</p>}
    <div className="modal-actions runner-bottom-actions"><button className="save" disabled={running} onClick={p.onClose}>Close</button><button className="save" disabled={running || !results.length} onClick={() => downloadJson('reqmas-run-results', { ...runMetadata, status: runStatus, results })}>Export results</button>{running ? <button className="danger-button" onClick={() => abort.current?.abort()}>Stop run</button> : <><button className="save" disabled={!retryTasks.length} onClick={() => void run(true)}>Retry failed ({retryTasks.length})</button><button className="send" disabled={loading || !!parsed.error || !!fileError || !!runError || !selection.requests.length} onClick={() => void run()}>Run collection</button></>}</div>
  </Modal>
}

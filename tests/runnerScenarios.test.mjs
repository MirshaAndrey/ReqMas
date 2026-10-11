import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunnerTasks, failedRunnerTasks, moveRunnerRequest, orderedRunnerRequests, RUNNER_MAX_EXECUTIONS, uniqueRunnerScenarioName, validateRunnerScenarios } from '../src/services/runnerScenarios.ts'
import { createBackup, parseBackup } from '../src/services/backup.ts'

const request = (id, collectionId = 'c') => ({ id, collectionId, name: `Request ${id}`, method: 'GET', url: 'https://example.test/{{id}}', params: [], headers: [], bodyType: 'none', body: '', variables: [] })
const scenario = (extra = {}) => ({ version: 1, id: 'scenario-1', name: 'Smoke test', collectionId: 'c', requestIds: ['b', 'a'], iterations: 3, delayMs: 100, stopOnFailure: true, datasetText: 'id\n1\n2', datasetFormat: 'csv', ...extra })
const workspace = () => ({ collections: [{ id: 'c', name: 'API' }], requests: [request('a'), request('b')], environments: [], environmentId: '', cookies: [], history: [], trash: { collections: [], requests: [] } })

test('saved scenarios preserve manual order, dataset text, settings and stale references through workspace backups', () => {
  const data = workspace(); data.runnerScenarios = [scenario({ requestIds: ['b', 'a', 'deleted'], datasetText: '[{"id":9007199254740993,"value":"Привет 😀"}]', datasetFormat: 'json' })]
  const restored = parseBackup(JSON.stringify(createBackup(data, 'dark')))
  assert.deepEqual(restored.data.runnerScenarios, data.runnerScenarios)
  data.runnerScenarios[0].name = 'Changed after export'
  assert.equal(restored.data.runnerScenarios[0].name, 'Smoke test')
  const selected = orderedRunnerRequests(restored.data.requests, 'c', restored.data.runnerScenarios[0].requestIds)
  assert.deepEqual(selected.requests.map(r => r.id), ['b', 'a'])
  assert.deepEqual(selected.missingIds, ['deleted'])
})

test('legacy backups remain valid and missing collection references are recoverable instead of discarded', () => {
  const backup = createBackup(workspace(), 'system')
  assert.equal(Object.hasOwn(parseBackup(JSON.stringify(backup)).data, 'runnerScenarios'), false)
  backup.data.runnerScenarios = [scenario({ collectionId: 'deleted-collection' })]
  assert.equal(parseBackup(JSON.stringify(backup)).data.runnerScenarios[0].collectionId, 'deleted-collection')
  assert.deepEqual(orderedRunnerRequests(backup.data.requests, 'deleted-collection', ['a', 'b']), { requests: [], missingIds: ['a', 'b'] })
})

test('scenario validator rejects invalid versions, duplicate IDs, request IDs and bounded settings', () => {
  for (const extra of [{ version: 2 }, { id: '' }, { name: '  ' }, { name: 'x'.repeat(201) }, { collectionId: '' }, { requestIds: ['a', 'a'] }, { requestIds: [''] }, { requestIds: [3] }, { iterations: 0 }, { iterations: 101 }, { iterations: 1.5 }, { delayMs: -1 }, { delayMs: 60001 }, { delayMs: 0.5 }, { stopOnFailure: 'yes' }, { datasetFormat: 'yaml' }, { datasetText: null }, { datasetText: '[{}]', datasetFormat: 'json' }]) assert.throws(() => validateRunnerScenarios([scenario(extra)]), /runnerScenarios/, JSON.stringify(extra))
  assert.throws(() => validateRunnerScenarios([scenario(), scenario()]), /duplicate ID/)
  assert.throws(() => validateRunnerScenarios(Array.from({ length: 101 }, (_, i) => scenario({ id: `s${i}` }))), /maximum 100/)
  assert.throws(() => validateRunnerScenarios([scenario({ datasetText: 'id\n' + 'я'.repeat(524288) })]), /1 MiB/)
  assert.deepEqual(validateRunnerScenarios([scenario({ datasetText: '' })])[0].datasetText, '')
})

test('duplicate names remain independently addressable by ID and newly saved names cannot overwrite existing names', () => {
  const two = validateRunnerScenarios([scenario(), scenario({ id: 'scenario-2' })])
  assert.equal(two.length, 2)
  assert.equal(uniqueRunnerScenarioName(' smoke test ', two), 'smoke test (2)')
  assert.equal(uniqueRunnerScenarioName('Smoke test', [scenario()], 'scenario-1'), 'Smoke test')
  assert.equal(uniqueRunnerScenarioName(' ', []), 'Runner scenario')
  assert.equal(uniqueRunnerScenarioName('Smoke test', [...two, scenario({ id: '3', name: 'Smoke test (2)' })]), 'Smoke test (3)')
})

test('request order is explicit and deduplicated; requests from other collections never become runnable', () => {
  const requests = [request('a'), request('b'), request('other', 'different')]
  const before = structuredClone(requests)
  const result = orderedRunnerRequests(requests, 'c', ['b', 'other', 'a', 'b', 'missing'])
  assert.deepEqual(result.requests.map(r => r.id), ['b', 'a'])
  assert.deepEqual(result.missingIds, ['other', 'missing'])
  assert.deepEqual(requests, before)
  assert.deepEqual(moveRunnerRequest(['b', 'a', 'c'], 'a', -1), ['a', 'b', 'c'])
  assert.deepEqual(moveRunnerRequest(['b', 'a', 'c'], 'a', 1), ['b', 'c', 'a'])
  assert.deepEqual(moveRunnerRequest(['b', 'a'], 'b', -1), ['b', 'a'])
  assert.deepEqual(moveRunnerRequest(['b', 'a'], 'a', 1), ['b', 'a'])
  assert.deepEqual(moveRunnerRequest(['b', 'a'], 'missing', 1), ['b', 'a'])
})

test('execution plans snapshot exact row variables and request content in manual request order', () => {
  const requests = [request('b'), request('a')], rows = [{ id: '9007199254740993', empty: '' }, { id: '2', value: 'Привет 😀' }]
  const tasks = createRunnerTasks(requests, 99, rows)
  assert.deepEqual(tasks.map(t => [t.request.id, t.iteration, t.datasetRow]), [['b', 1, 1], ['a', 1, 1], ['b', 2, 2], ['a', 2, 2]])
  requests[0].url = 'changed'; rows[0].id = 'changed'
  assert.equal(tasks[0].request.url, 'https://example.test/{{id}}')
  assert.equal(tasks[0].variables.find(p => p.key === 'id').value, '9007199254740993')
  assert.equal(tasks[0].variables.find(p => p.key === 'empty').value, '')
  assert.notEqual(tasks[0].id, tasks[2].id)
  assert.equal(tasks[2].variables.find(p => p.key === 'value').value, 'Привет 😀')
})

test('retry selects failing occurrences only, preserving row and iteration; passed, cancelled and unexecuted tasks stay excluded', () => {
  const tasks = createRunnerTasks([request('b'), request('a')], 3)
  const results = [
    { taskId: tasks[0].id, passed: true, attempt: 1 },
    { taskId: tasks[1].id, passed: false, attempt: 1 },
    { taskId: tasks[2].id, passed: false, attempt: 1 },
    { taskId: tasks[3].id, passed: false, cancelled: true, attempt: 1 },
  ]
  const retry = failedRunnerTasks(tasks, results)
  assert.deepEqual(retry.map(t => [t.request.id, t.iteration]), [['a', 1], ['b', 2]])
  assert.equal(retry[0], tasks[1])
  assert.equal(retry[1], tasks[2])
  assert.deepEqual(failedRunnerTasks(tasks, [...results, { taskId: tasks[1].id, passed: true, attempt: 2 }]).map(t => t.id), [tasks[2].id])
  assert.deepEqual(failedRunnerTasks(tasks, [...results, { taskId: tasks[2].id, passed: false, cancelled: true, attempt: 2 }]).map(t => t.id), [tasks[1].id])
})

test('retrying one failed dataset row never repeats successful rows or adds a new iteration', () => {
  const tasks = createRunnerTasks([request('a')], 1, [{ id: '1' }, { id: '2' }, { id: '3' }])
  const retry = failedRunnerTasks(tasks, tasks.map((task, index) => ({ taskId: task.id, passed: index !== 1, attempt: 1 })))
  assert.equal(retry.length, 1)
  assert.equal(retry[0].iteration, 2)
  assert.equal(retry[0].datasetRow, 2)
  assert.deepEqual(retry[0].variables.map(v => [v.key, v.value]), [['id', '2']])
})

test('plans cap work before allocating excessive tasks and reject invalid iteration counts', () => {
  assert.equal(createRunnerTasks([request('a')], 100).length, 100)
  for (const count of [0, -1, 1.5, 101, NaN]) assert.throws(() => createRunnerTasks([request('a')], count), /iterations/)
  assert.throws(() => createRunnerTasks(Array.from({ length: Math.floor(RUNNER_MAX_EXECUTIONS / 100) + 1 }, (_, i) => request(String(i))), 100), /at most 10,000/)
})

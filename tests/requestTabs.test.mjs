import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { upsertSavedRequest } from '../src/services/appState.ts'

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const react = moduleUrl(`export const useState = value => globalThis.__reqmasTabTest.useState(value); export const useEffect = () => {};`)
const database = moduleUrl(`export const read = (key, fallback) => fallback; export const write = () => {};`)
const source = readFileSync(new URL('../src/hooks/useRequestTabs.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace("from 'react'", `from '${react}'`)
  .replace("from '../storage/database'", `from '${database}'`)
  .replace("from '../services/queryParams'", `from '${new URL('../src/services/queryParams.ts', import.meta.url).href}'`)
const { useRequestTabs } = await import(moduleUrl(compiled))

function renderTabs(initial) {
  const states = []; let cursor = 0
  globalThis.__reqmasTabTest = { useState(value) {
    const index = cursor++
    if (!(index in states)) states[index] = typeof value === 'function' ? value() : value
    return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
  } }
  return () => { cursor = 0; return useRequestTabs(initial, () => {}) }
}
const request = extra => ({ id: 'r', collectionId: 'c', name: 'Original', method: 'GET', url: 'https://example.test/original', params: [], headers: [], bodyType: 'none', body: '', ...extra })

test('saving and closing the only edited tab opens the saved version instead of the older request', () => {
  const original = request(), render = renderTabs(original)
  let tabs = render()
  const edited = request({ name: 'Changed', url: 'https://example.test/changed' })
  tabs.field('request')(edited); tabs = render()
  const saved = upsertSavedRequest([original], tabs.active.request)
  tabs.close(tabs.active.id, saved[0]); tabs = render()
  assert.deepEqual(tabs.active.request, edited)
  assert.deepEqual(saved[0], tabs.active.request)
  assert.equal(original.name, 'Original')
})

test('saving and closing the first request in an empty workspace preserves it as the fallback tab', () => {
  const edited = request({ name: 'First saved request' }), render = renderTabs(edited)
  let tabs = render()
  const saved = upsertSavedRequest([], tabs.active.request)
  tabs.close(tabs.active.id, saved[0]); tabs = render()
  assert.equal(tabs.tabs.length, 1)
  assert.deepEqual(tabs.active.request, saved[0])
})

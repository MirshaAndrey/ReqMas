import test from 'node:test'
import assert from 'node:assert/strict'
import { changeRequestParams, changeRequestUrl, queryRows, splitQueryUrl } from '../src/services/queryParams.ts'
import { prepareRequest } from '../src/services/prepareRequest.ts'
import { exportCollection } from '../src/services/workspace.ts'
import { importPostman } from '../src/services/postmanImport.ts'

const pair = (key, value, enabled = true) => ({ id: crypto.randomUUID(), key, value, enabled })
const request = (extra = {}) => ({ id: 'query', collectionId: 'c', name: 'Query', method: 'GET', url: 'https://example.test/search', params: [], headers: [], bodyType: 'none', body: '', ...extra })
const values = rows => rows.map(({ key, value, enabled }) => [key, value, enabled])
const wireQuery = (r, variables = []) => [...new URL(prepareRequest(r, [], variables).url).searchParams]

test('adding a parameter updates the visible URL and sends it exactly once', () => {
  const original = request()
  const next = { ...original, ...changeRequestParams(original, [pair('page', '2')]) }
  assert.equal(new URL(next.url).searchParams.get('page'), '2')
  assert.deepEqual(wireQuery(next), [['page', '2']])
  assert.equal(original.url, 'https://example.test/search')
  assert.deepEqual(original.params, [])
})

test('editing the URL creates decoded table rows while preserving the typed URL', () => {
  const old = pair('q', 'old')
  const original = request({ params: [old] })
  const typed = 'https://example.test/search?q=a%26b&tag=%D0%BA%D0%B8%D1%97%D0%B2+%F0%9F%98%80&tag=second&empty=#section'
  const next = changeRequestUrl(original, typed)
  assert.equal(next.url, typed)
  assert.deepEqual(values(next.params), [['q', 'a&b', true], ['tag', 'київ 😀', true], ['tag', 'second', true], ['empty', '', true]])
  assert.equal(next.params[0].id, old.id)
  assert.deepEqual(wireQuery({ ...original, ...next }), [['q', 'a&b'], ['tag', 'київ 😀'], ['tag', 'second'], ['empty', '']])
})

test('editing a table value replaces the inline value instead of adding a duplicate', () => {
  const row = pair('q', 'old')
  const original = request({ url: 'https://example.test/search?q=old#results', params: [row] })
  const next = { ...original, ...changeRequestParams(original, [{ ...row, value: 'new' }]) }
  assert.deepEqual([...new URL(next.url).searchParams], [['q', 'new']])
  assert.equal(new URL(next.url).hash, '#results')
  assert.deepEqual(wireQuery(next), [['q', 'new']])
})

test('disabling, re-enabling and deleting a row changes both URL and wire data', () => {
  const row = pair('q', 'keep me')
  const original = request({ url: 'https://example.test/search?q=keep+me', params: [row] })
  const disabled = { ...original, ...changeRequestParams(original, [{ ...row, enabled: false }]) }
  assert.equal(new URL(disabled.url).search, '')
  assert.deepEqual(wireQuery(disabled), [])
  assert.equal(disabled.params[0].value, 'keep me')
  const enabled = { ...disabled, ...changeRequestParams(disabled, [{ ...row, enabled: true }]) }
  assert.deepEqual(wireQuery(enabled), [['q', 'keep me']])
  const removed = { ...enabled, ...changeRequestParams(enabled, []) }
  assert.equal(new URL(removed.url).search, '')
  assert.deepEqual(wireQuery(removed), [])
})

test('duplicate keys remain ordered and are not duplicated again during sending', () => {
  const rows = [pair('tag', 'first'), pair('tag', 'second'), pair('tag', 'disabled', false)]
  const original = request({ url: 'https://example.test/search?tag=old&tag=old2', params: rows })
  assert.deepEqual(values(queryRows(original)), values(rows))
  assert.deepEqual(wireQuery(original), [['tag', 'first'], ['tag', 'second']])
  const next = { ...original, ...changeRequestParams(original, rows) }
  assert.deepEqual([...new URL(next.url).searchParams], [['tag', 'first'], ['tag', 'second']])
  assert.deepEqual(wireQuery(next), [['tag', 'first'], ['tag', 'second']])
})

test('legacy inline query is retained while the table overrides matching keys, including disabled rows', () => {
  const original = request({ url: 'https://example.test/search?inline=keep&q=old&off=old', params: [pair('q', 'new'), pair('off', 'blocked', false), pair('added', 'yes')] })
  assert.deepEqual(wireQuery(original), [['inline', 'keep'], ['q', 'new'], ['added', 'yes']])
  const next = { ...original, ...changeRequestParams(original, queryRows(original)) }
  assert.deepEqual(wireQuery(next), [['inline', 'keep'], ['q', 'new'], ['added', 'yes']])
})

test('Unicode, ampersands, fragments and plus signs stay inside their parameter values', () => {
  const rows = [pair('ключ &', 'київ 😀 & # + ? = /'), pair('plus', '+'), pair('blank', '')]
  const original = request({ url: 'https://example.test/search#anchor?not=query' })
  const next = { ...original, ...changeRequestParams(original, rows) }
  const expected = rows.map(({ key, value }) => [key, value])
  assert.deepEqual([...new URL(next.url).searchParams], expected)
  assert.deepEqual(wireQuery(next), expected)
  assert.equal(new URL(next.url).hash, '#anchor?not=query')
})

test('query templates stay editable and resolve to a single escaped value', () => {
  const original = request({ url: '{{base}}/search#section', params: [] })
  const next = { ...original, ...changeRequestParams(original, [pair('{{key}}', '{{value}}'), pair('literal', '{{value}} suffix')]) }
  assert.ok(next.url.includes('{{base}}'))
  assert.ok(next.url.includes('{{key}}'))
  assert.ok(next.url.includes('{{value}}'))
  const variables = [pair('base', 'https://example.test'), pair('key', 'q&key'), pair('value', 'київ & # +')]
  assert.deepEqual(wireQuery(next, variables), [['q&key', 'київ & # +'], ['literal', 'київ & # + suffix']])
  assert.equal(new URL(prepareRequest(next, [], variables).url).hash, '#section')
})

test('templates typed directly into a query resolve without interpreting their values as query syntax', () => {
  const original = request()
  const typed = '{{base}}/search?{{key}}={{value}}&fixed=yes'
  const next = { ...original, ...changeRequestUrl(original, typed) }
  assert.equal(next.url, typed)
  assert.deepEqual(values(next.params), [['{{key}}', '{{value}}', true], ['fixed', 'yes', true]])
  assert.deepEqual(wireQuery(next, [pair('base', 'https://example.test'), pair('key', 'q'), pair('value', 'a&injected=false#fragment')]), [['q', 'a&injected=false#fragment'], ['fixed', 'yes']])
})

test('changing the URL removes absent enabled rows but keeps absent disabled rows', () => {
  const active = pair('active', 'old')
  const disabled = pair('saved', 'remember', false)
  const original = request({ url: 'https://example.test/search?active=old', params: [active, disabled] })
  const next = changeRequestUrl(original, 'https://example.test/other?new=value')
  assert.deepEqual(values(next.params), [['new', 'value', true], ['saved', 'remember', false]])
  assert.equal(next.params[1].id, disabled.id)
  assert.deepEqual(wireQuery({ ...original, ...next }), [['new', 'value']])
})

test('URL edits reuse distinct row IDs for repeated query keys', () => {
  const rows = [pair('tag', 'one'), pair('tag', 'two')]
  const original = request({ params: rows })
  const next = changeRequestUrl(original, 'https://example.test/search?tag=three&tag=four')
  assert.deepEqual(next.params.map(row => row.id), rows.map(row => row.id))
  assert.deepEqual(values(next.params), [['tag', 'three', true], ['tag', 'four', true]])
})

test('splitting a URL respects the fragment and works before a template URL resolves', () => {
  assert.deepEqual(splitQueryUrl('{{base}}/search?q={{value}}#section?inside'), { base: '{{base}}/search', query: 'q={{value}}', fragment: '#section?inside' })
  assert.deepEqual(splitQueryUrl('https://example.test/search#section?inside'), { base: 'https://example.test/search', query: '', fragment: '#section?inside' })
})

test('a synchronized query survives saving as a Postman collection and importing again', () => {
  const original = request({ url: 'https://example.test/search?inline=keep' })
  const rows = [...queryRows(original), pair('tag', 'a&b'), pair('tag', 'two'), pair('off', 'saved', false)]
  const next = { ...original, ...changeRequestParams(original, rows) }
  const text = JSON.stringify(exportCollection({ id: 'c', name: 'Queries' }, [next]))
  const restored = importPostman(text).requests[0]
  assert.deepEqual(wireQuery(restored), wireQuery(next))
  assert.deepEqual(values(restored.params), values(next.params))
})

test('Postman export retains legacy inline-only and mixed query data', () => {
  const fixtures = [
    request({ url: 'https://example.test/search?inline=a%26b&tag=first&tag=second', params: [] }),
    request({ url: 'https://example.test/search?inline=keep&q=old&off=old', params: [pair('q', 'new'), pair('off', 'saved', false), pair('added', 'yes')] }),
  ]
  for (const original of fixtures) {
    const before = JSON.stringify(original)
    const text = JSON.stringify(exportCollection({ id: 'c', name: 'Legacy queries' }, [original]))
    const restored = importPostman(text).requests[0]
    assert.deepEqual(wireQuery(restored), wireQuery(original))
    assert.deepEqual(values(restored.params), values(queryRows(original)))
    assert.equal(JSON.stringify(original), before)
  }
})

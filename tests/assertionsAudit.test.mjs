import test from 'node:test'
import assert from 'node:assert/strict'
import { checkResponse } from '../src/services/workspace.ts'
const rule = (key, expected) => ({ id: crypto.randomUUID(), kind: 'json', key, expected, enabled: true })
const response = body => ({ status: 200, statusText: 'OK', duration: 12, size: body.length, headers: {}, body })

test('JSON assertions preserve unsafe integer IDs and do not equate neighboring numeric values', () => {
  const result = checkResponse([rule('id', '9007199254740993'), rule('id', '9007199254740992')], response('{"id":9007199254740993}'))
  assert.deepEqual(result.map(r => r.passed), [true, false])
  assert.equal(result[0].actual, '9007199254740993')
})
test('JSON assertions preserve precise decimals, nested numeric values and ordinary strings', () => {
  const body = '{"value":0.1000000000000000001,"nested":{"ids":[9007199254740993,1]},"name":"Alice"}'
  const result = checkResponse([rule('value', '0.1000000000000000001'), rule('nested', '{"ids":[9007199254740993,1]}'), rule('name', 'Alice')], response(body))
  assert.ok(result.every(r => r.passed))
})

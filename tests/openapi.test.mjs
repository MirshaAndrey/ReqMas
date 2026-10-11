import test from 'node:test'
import assert from 'node:assert/strict'
import { Validator } from '@cfworker/json-schema'
import { importOpenApi } from '../src/services/openApiImport.ts'
import { prepareRequest } from '../src/services/prepareRequest.ts'
const doc = extra => JSON.stringify({ openapi: '3.1.0', info: { title: 'Example API', version: '1.0' }, servers: [{ url: 'https://example.test/v1' }], paths: {}, ...extra })

test('OpenAPI merges parameter scopes, templates path variables and synchronizes visible query URLs', () => {
  const result = importOpenApi(doc({ paths: { '/users/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', default: 5 } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } }], get: { summary: 'Read user', tags: ['Users'], parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } }, { name: 'verbose', in: 'query', schema: { type: 'boolean' } }, { name: 'X-Required', in: 'header', required: true, schema: { type: 'string', example: 'yes' } }], responses: { 200: { description: 'OK' } } } } } }))
  const request = result.requests[0]
  assert.equal(result.collection.name, 'Example API'); assert.deepEqual(result.collection.folders, ['Users'])
  assert.equal(request.name, 'Read user'); assert.equal(request.url, 'https://example.test/v1/users/{{id}}?limit=25')
  assert.equal(request.variables.find(v => v.key === 'id').value, '5')
  assert.equal(request.params.find(v => v.key === 'verbose').enabled, false)
  assert.equal(request.headers.find(v => v.key === 'X-Required').enabled, true)
  assert.equal(prepareRequest(request).url, 'https://example.test/v1/users/5?limit=25')
})

test('YAML imports OpenAPI local request body references, server defaults and generated JSON examples', () => {
  const result = importOpenApi(`openapi: 3.0.3
info: {title: YAML API, version: 1.0.0}
servers:
  - url: https://{region}.example.test
    variables:
      region: {default: eu}
paths:
  /users:
    post:
      operationId: createUser
      requestBody:
        $ref: '#/components/requestBodies/User'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
components:
  requestBodies:
    User:
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/User'
  schemas:
    User:
      type: object
      required: [name]
      properties:
        name: {type: string, example: Alice}
        id: {type: integer, readOnly: true}
`)
  const request = result.requests[0]
  assert.equal(request.url, 'https://eu.example.test/users'); assert.equal(request.name, 'createUser')
  assert.deepEqual(JSON.parse(request.body), { name: 'Alice' }); assert.equal(request.bodyType, 'json')
  const schema = JSON.parse(request.responseSchema)
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(schema.$defs.schema1.properties.id.type, 'integer')
  assert.equal(result.skipped, 0)
})

test('Swagger 2 imports base paths, Basic authentication, form fields and file warnings', () => {
  const result = importOpenApi(JSON.stringify({ swagger: '2.0', info: { title: 'Legacy' }, schemes: ['http'], host: 'localhost:9999', basePath: '/v2', securityDefinitions: { login: { type: 'basic' } }, security: [{ login: [] }], paths: { '/upload': { post: { consumes: ['multipart/form-data'], parameters: [{ in: 'formData', name: 'title', type: 'string', required: true, default: 'Report' }, { in: 'formData', name: 'file', type: 'file', required: true }], responses: { 200: { description: 'OK', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } } } }))
  const request = result.requests[0]
  assert.equal(request.url, 'http://localhost:9999/v2/upload'); assert.equal(request.bodyType, 'formdata')
  assert.deepEqual(request.form.map(p => [p.key, p.value, p.enabled]), [['title', 'Report', true]])
  assert.equal(request.authMode, 'basic'); assert.equal(request.basicAuth.username, '{{authUsername}}')
  assert.ok(result.warnings.some(w => w.includes('local file') && w.includes('file')))
  assert.ok(request.responseSchema)
})

test('query array serialization supports repeated values, pipe delimiters and deep objects', () => {
  const request = importOpenApi(doc({ paths: { '/search': { get: { parameters: [{ name: 'tag', in: 'query', schema: { type: 'array', example: ['a&b', 'c'] } }, { name: 'ids', in: 'query', style: 'pipeDelimited', explode: false, schema: { type: 'array', example: [1, 2] } }, { name: 'filter', in: 'query', style: 'deepObject', schema: { type: 'object', example: { name: 'Alice', active: true } } }], responses: {} } } } })).requests[0]
  assert.deepEqual(request.params.map(p => [p.key, p.value]), [['tag', 'a&b'], ['tag', 'c'], ['ids', '1|2'], ['filter[name]', 'Alice'], ['filter[active]', 'true']])
  assert.equal(prepareRequest(request).url, 'https://example.test/v1/search?tag=a%26b&tag=c&ids=1%7C2&filter%5Bname%5D=Alice&filter%5Bactive%5D=true')
})

test('relative and missing servers use editable fallback while operation servers override global servers', () => {
  const result = importOpenApi(doc({ servers: [{ url: '/api' }], paths: { '/users': { get: { responses: {} }, post: { servers: [{ url: 'https://write.example.test/v2' }], responses: {} } } } }), { baseUrl: 'http://localhost:8080/' })
  assert.equal(result.requests[0].url, 'http://localhost:8080/api/users')
  assert.equal(result.requests[1].url, 'https://write.example.test/v2/users')
  assert.ok(result.warnings.some(w => w.includes('fallback')))
  assert.throws(() => importOpenApi(doc({}), { baseUrl: 'file:///private' }), /HTTP\/HTTPS/)
})

test('operation security can opt out or choose supported API key alternatives without partial AND auth', () => {
  const result = importOpenApi(doc({ security: [{ bearer: [] }], components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, key: { type: 'apiKey', name: 'X-Key', in: 'header' }, unsupported: { type: 'openIdConnect', openIdConnectUrl: 'https://example.test/login' } } }, paths: { '/public': { get: { security: [], responses: {} } }, '/private': { get: { security: [{ unsupported: [] }, { key: [] }], responses: {} } }, '/both': { get: { security: [{ key: [], bearer: [] }], responses: {} } }, '/inherited': { get: { responses: {} } } } }))
  assert.deepEqual(result.requests.map(r => r.authMode), ['none', 'apikey', 'none', 'bearer'])
  assert.equal(result.requests[1].apiKey.key, 'X-Key')
  assert.ok(result.warnings.some(w => w.includes('single Basic')))
})

test('recursive response references are rebased into self-contained definitions; request cycles stop safely', () => {
  const result = importOpenApi(doc({ components: { schemas: { Node: { type: 'object', properties: { value: { type: 'string' }, next: { nullable: true, $ref: '#/components/schemas/Node' }, nullable: { type: 'string' }, example: { type: 'number' } } } } }, paths: { '/nodes': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } }, responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } } } }))
  assert.equal(result.requests.length, 1)
  const request = result.requests[0]; const schema = JSON.parse(request.responseSchema)
  assert.equal(schema.$ref, '#/$defs/schema1')
  assert.equal(schema.$defs.schema1.properties.next.anyOf[0].$ref, '#/$defs/schema1')
  assert.equal(schema.$defs.schema1.properties.nullable.type, 'string')
  assert.equal(schema.$defs.schema1.properties.example.type, 'number')
  const validator = new Validator(schema, '2020-12', false)
  assert.equal(validator.validate({ value: 'root', next: { value: 'child', next: null } }).valid, true)
  assert.equal(validator.validate({ value: 'root', next: { value: 123 } }).valid, false)
  assert.equal(JSON.parse(request.body).next, null)
  assert.ok(result.warnings.some(w => w.includes('Recursive')))
})

test('schema conversion preserves literals, nullable fields and Swagger exclusive bounds', () => {
  const result = importOpenApi(doc({ paths: { '/values': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', required: ['nullable', 'number'], properties: { nullable: { type: 'string', nullable: true }, number: { type: 'number', minimum: 5, exclusiveMinimum: true }, literal: { const: { $ref: 'a literal value', nullable: 'a literal key' } } } } } } } } } } } }))
  const schema = JSON.parse(result.requests[0].responseSchema)
  assert.deepEqual(schema.properties.literal.const, { $ref: 'a literal value', nullable: 'a literal key' })
  assert.equal(schema.properties.number.exclusiveMinimum, 5)
  const validator = new Validator(schema, '2020-12', false)
  assert.equal(validator.validate({ nullable: null, number: 6 }).valid, true)
  assert.equal(validator.validate({ nullable: null, number: 5 }).valid, false)
})

test('unresolved, external and cyclic operation references never fetch and do not block valid operations', () => {
  const result = importOpenApi(doc({ components: { parameters: { circular: { $ref: '#/components/parameters/circular' } } }, paths: { '/external': { $ref: 'https://example.test/private.json#/paths/a' }, '/missing': { get: { parameters: [{ $ref: '#/components/parameters/missing' }] } }, '/cycle': { get: { parameters: [{ $ref: '#/components/parameters/circular' }] } }, '/safe': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: 'private.yaml#/Secret' } } } } } } } } }))
  assert.equal(result.requests.length, 1); assert.equal(result.requests[0].url, 'https://example.test/v1/safe')
  assert.equal(result.requests[0].responseSchema, undefined); assert.equal(result.skipped, 3)
  assert.ok(result.warnings.some(w => w.includes('Only local'))); assert.ok(result.warnings.some(w => w.includes('Unresolved'))); assert.ok(result.warnings.some(w => w.includes('Circular')))
})

test('import rejects malformed, duplicate-key and cyclic YAML documents before creating collections', () => {
  assert.throws(() => importOpenApi('{broken'), /Invalid JSON or YAML/)
  assert.throws(() => importOpenApi('{"item":[]}'), /OpenAPI/)
  assert.throws(() => importOpenApi(doc({ paths: [] })), /paths object/)
  assert.throws(() => importOpenApi('openapi: 3.0.0\nopenapi: 3.1.0\npaths: {}'), /Invalid JSON or YAML/)
  assert.throws(() => importOpenApi('openapi: 3.1.0\npaths: {}\nx-cycle: &cycle [*cycle]'), /Cyclic YAML/)
  assert.throws(() => importOpenApi(' '.repeat(2 * 1024 * 1024 + 1)), /2 MiB/)
})

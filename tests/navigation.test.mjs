import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFolderTree, flattenFolderTree, folderMatchesSearch, navigationMatches, moveRequestOrder, moveCollectionOrder } from '../src/services/navigation.ts'

const request = (id, collectionId = 'c', folder) => ({ id, collectionId, folder, name: id, method: 'GET', url: '', params: [], headers: [], bodyType: 'none', body: '' })

test('folder tree adds implicit ancestors and treats prototype names as ordinary folders', () => {
  const folders = ['Users/Admin', 'constructor', '__proto__/toString', 'Empty']
  const requests = [request('r', 'c', 'Users/Admin/Details'), request('p', 'c', '__proto__/toString'), request('root')]
  const tree = buildFolderTree(folders, requests)
  assert.deepEqual(flattenFolderTree(tree), ['Users', 'Users/Admin', 'Users/Admin/Details', 'constructor', '__proto__', '__proto__/toString', 'Empty'])
  assert.equal(tree[0].children[0].children[0].name, 'Details')
  assert.deepEqual(folders, ['Users/Admin', 'constructor', '__proto__/toString', 'Empty'])
  assert.equal(new Set(flattenFolderTree(tree)).size, flattenFolderTree(tree).length)
})

test('search reveals the ancestors of matching requests and nested empty folders without showing unrelated branches', () => {
  const tree = buildFolderTree(['Users/Admin', 'Reports/Empty', 'Other'], [])
  assert.equal(folderMatchesSearch(tree[1], [], 'API', 'empty'), true)
  assert.equal(folderMatchesSearch(tree[0], [], 'API', 'empty'), false)
  const requests = [request('r', 'c', 'Users/Admin')]
  requests[0].name = 'Get permissions'
  assert.equal(folderMatchesSearch(tree[0], requests, 'API', 'permissions'), true)
  assert.equal(folderMatchesSearch(tree[2], requests, 'API', 'permissions'), false)
  assert.equal(navigationMatches(requests[0], 'API', '  PERMISSIONS  '), true)
  assert.equal(folderMatchesSearch(tree[2], requests, 'API', 'api'), true)
})

test('imported paths with empty segments remain exact and every request folder can be found', () => {
  const paths = ['/Users/', 'Users//Admin', '/', 'Users/constructor/']
  const tree = buildFolderTree([], paths.map((folder, index) => request(String(index), 'c', folder)))
  const rendered = flattenFolderTree(tree)
  for (const path of paths) assert.ok(rendered.includes(path), path)
})

test('moving across collections changes only the moved request metadata and preserves outside ordering', () => {
  const original = [request('a'), request('x', 'other', 'constructor'), request('b'), request('y', 'other', 'constructor'), request('z', 'third')]
  const moved = moveRequestOrder(original, 'b', 'other', 'constructor', 'y')
  assert.deepEqual(moved.map(item => item.id), ['a', 'x', 'b', 'y', 'z'])
  assert.deepEqual(moved.find(item => item.id === 'b'), { ...original[2], collectionId: 'other', folder: 'constructor' })
  assert.equal(moved[0], original[0]); assert.equal(moved[1], original[1]); assert.equal(moved[3], original[3])
  assert.equal(original[2].collectionId, 'c')
})

test('moving to root appends to existing root siblings and clears the previous folder', () => {
  const original = [request('a', 'c', 'deep'), request('root'), request('child', 'c', 'deep'), request('other', 'other')]
  const moved = moveRequestOrder(original, 'a', 'c', '')
  assert.deepEqual(moved.map(item => item.id), ['root', 'a', 'child', 'other'])
  assert.equal(moved[1].folder, undefined)
})

test('an invalid before target never inserts a request into a different folder or collection', () => {
  const original = [request('source', 'a'), request('first', 'b', 'deep'), request('outside', 'c'), request('last', 'b', 'deep')]
  const moved = moveRequestOrder(original, 'source', 'b', 'deep', 'outside')
  assert.deepEqual(moved.map(item => item.id), ['first', 'outside', 'last', 'source'])
  assert.deepEqual(moveRequestOrder(original, 'source', 'empty', '__proto__').map(item => item.id), ['first', 'outside', 'last', 'source'])
})

test('same-folder up/down ordering is stable and self/unknown drops do not remove items', () => {
  const original = [request('a'), request('outside', 'other'), request('b'), request('c')]
  assert.deepEqual(moveRequestOrder(original, 'c', 'c', '', 'a').map(item => item.id), ['c', 'a', 'outside', 'b'])
  assert.deepEqual(moveRequestOrder(original, 'a', 'c', '', 'c').map(item => item.id), ['outside', 'b', 'a', 'c'])
  assert.equal(moveRequestOrder(original, 'b', 'c', '', 'b'), original)
  assert.equal(moveRequestOrder(original, 'missing', 'c'), original)
})

test('moving into an empty folder inserts after the target collection and preserves all requests', () => {
  const original = [request('source', 'other'), request('a'), request('b', 'c', 'existing'), request('outside', 'third')]
  const moved = moveRequestOrder(original, 'source', 'c', 'New/Folder')
  assert.deepEqual(moved.map(item => item.id), ['a', 'b', 'source', 'outside'])
  assert.equal(moved[2].folder, 'New/Folder')
  assert.equal(new Set(moved.map(item => item.id)).size, original.length)
})

test('collection moves support before, end, self, unknown and immutable source arrays', () => {
  const original = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]
  assert.deepEqual(moveCollectionOrder(original, 'c', 'a').map(item => item.id), ['c', 'a', 'b'])
  assert.deepEqual(moveCollectionOrder(original, 'a').map(item => item.id), ['b', 'c', 'a'])
  assert.deepEqual(moveCollectionOrder(original, 'b', 'unknown').map(item => item.id), ['a', 'c', 'b'])
  assert.equal(moveCollectionOrder(original, 'b', 'b'), original)
  assert.equal(moveCollectionOrder(original, 'missing'), original)
  assert.deepEqual(original.map(item => item.id), ['a', 'b', 'c'])
})

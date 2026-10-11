import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUpdateManifest, parseArguments, signatureMetadata } from '../tools/create-update-manifest.mjs'

const filename = 'Reqmas_0.3.0_x64-setup.exe'
// Structural test data; no private key is generated or used in these manifest tests.
function signature(version = '0.3.0', file = filename, extra = '') {
  const bytes = Buffer.alloc(74); bytes.write('ED')
  return Buffer.from(`untrusted comment: structural fixture\n${bytes.toString('base64')}\ntrusted comment: timestamp:123\tfile:${file}${version === null ? '' : '\tversion:' + version}${extra}\n${Buffer.alloc(64).toString('base64')}\n`).toString('base64')
}
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'reqmas-update-manifest-'))
  try {
    const artifact = join(directory, filename), output = join(directory, 'latest.json'), header = Buffer.alloc(256)
    header.write('MZ'); header.writeUInt32LE(128, 0x3c); header.write('PE\0\0', 128)
    await writeFile(artifact, header); await writeFile(artifact + '.sig', signature())
    await run({ directory, artifact, output, version: '0.3.0', url: 'https://example.test/' + filename })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('manifest embeds the exact signature, Windows x64 platform, notes and UTC publication date', () => fixture(async options => {
  const notesFile = join(options.directory, 'notes.txt'); await writeFile(notesFile, 'Исправления и новые функции')
  const manifest = await createUpdateManifest({ ...options, notesFile, date: '2026-10-09T12:00:00+03:00' })
  assert.equal(manifest.platforms['windows-x86_64'].signature, signature())
  assert.equal(manifest.platforms['windows-x86_64'].url, options.url)
  assert.equal(manifest.pub_date, '2026-10-09T09:00:00.000Z')
  assert.equal(manifest.notes, 'Исправления и новые функции')
  assert.deepEqual(JSON.parse(await readFile(options.output, 'utf8')), manifest)
}))

test('missing or mismatched signed app version and filename are rejected', () => {
  assert.throws(() => signatureMetadata(signature(null), '0.3.0', filename), /no signed app version/)
  assert.throws(() => signatureMetadata(signature('0.2.0'), '0.3.0', filename), /app version does not match/)
  assert.throws(() => signatureMetadata(signature('0.3.0', 'Other_x64-setup.exe'), '0.3.0', filename), /filename/)
  assert.throws(() => signatureMetadata(signature('0.3.0', filename, '\tversion:0.2.0'), '0.3.0', filename), /duplicate metadata/)
})

test('malformed, noncanonical, truncated and unsigned signature text are rejected', () => {
  for (const value of ['', 'signature.sig', 'https://example.test/installer.sig', Buffer.from('plain text').toString('base64'), signature().slice(1), 'x'.repeat(16385)]) assert.throws(() => signatureMetadata(value, '0.3.0', filename))
})

test('an existing output remains byte-for-byte intact', () => fixture(async options => {
  await writeFile(options.output, 'previous manifest bytes')
  await assert.rejects(createUpdateManifest(options), /already exists/)
  assert.equal(await readFile(options.output, 'utf8'), 'previous manifest bytes')
}))

test('a missing signature never creates a manifest', () => fixture(async options => {
  await rm(options.artifact + '.sig')
  await assert.rejects(createUpdateManifest(options), /ENOENT/)
  await assert.rejects(readFile(options.output), /ENOENT/)
}))

test('unsafe or different installer download URLs are rejected without writing output', () => fixture(async options => {
  for (const url of ['http://example.test/' + filename, 'https://name:secret@example.test/' + filename, 'https://example.test/' + filename + '#fragment', 'https://example.test/other.exe', 'not a URL']) await assert.rejects(createUpdateManifest({ ...options, url }))
  await assert.rejects(readFile(options.output), /ENOENT/)
}))

test('the portable application and invalid PE headers cannot be used as NSIS artifacts', () => fixture(async options => {
  await assert.rejects(createUpdateManifest({ ...options, artifact: join(options.directory, 'reqmas.exe') }), /NSIS artifact/)
  await writeFile(options.artifact, 'not a Windows executable')
  await assert.rejects(createUpdateManifest(options), /Windows executable/)
  await writeFile(options.artifact, Buffer.alloc(256))
  await assert.rejects(createUpdateManifest(options), /PE header/)
}))

test('invalid SemVer and dates cannot create manifests', () => fixture(async options => {
  for (const version of ['v0.3.0', '03.0.0', '0.3', '0.3.0-01', '0.3.0\n']) await assert.rejects(createUpdateManifest({ ...options, version }), /SemVer/)
  for (const date of ['tomorrow', '2026-10-09', '2026-99-99T00:00:00Z', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-10-09T24:00:00Z', '2026-10-09T00:00:00+25:00']) await assert.rejects(createUpdateManifest({ ...options, date }), /RFC 3339/)
  await assert.rejects(readFile(options.output), /ENOENT/)
}))

test('invalid UTF-8 release notes cannot create a manifest', () => fixture(async options => {
  const notesFile = join(options.directory, 'notes.txt'); await writeFile(notesFile, Buffer.from([255, 254]))
  await assert.rejects(createUpdateManifest({ ...options, notesFile }), /UTF-8/)
  await assert.rejects(readFile(options.output), /ENOENT/)
}))

test('CLI parsing preserves paths with spaces and rejects duplicate, missing and unknown options', () => {
  assert.equal(parseArguments(['--artifact', 'path with spaces.exe']).artifact, 'path with spaces.exe')
  assert.equal(parseArguments(['--help']), null)
  for (const args of [['--artifact'], ['--overwrite', 'yes'], ['--version', '0.3.0', '--version', '0.4.0'], ['--version', '--output']]) assert.throws(() => parseArguments(args), /Invalid or duplicate/)
})

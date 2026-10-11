import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HELP = `Create a static Tauri update manifest for a signed Windows x64 NSIS installer.

node tools/create-update-manifest.mjs --artifact PATH --version 0.3.0 --url HTTPS_URL --output PATH
Optional: --signature PATH (defaults to artifact + .sig), --notes-file PATH, --date RFC3339

The signature must bind the same filename and app version. Existing output is never overwritten.
This checks signature structure and metadata; Tauri verifies the cryptographic signature before installation.`

function semver(value) {
  if (typeof value !== 'string' || value.length > 128) throw new Error('Version must be a valid SemVer without a leading v.')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match || match.slice(1, 4).some(part => BigInt(part) > 18446744073709551615n) || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error('Version must be a valid SemVer without a leading v.')
  return value
}
function decodeBase64(value, label) {
  if (!value || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`${label} is not valid base64.`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error(`${label} is not canonical base64.`)
  return bytes
}
export function signatureMetadata(signature, expectedVersion, filename) {
  if (typeof signature !== 'string' || signature.length > 16384) throw new Error('Signature must be the contents of the Tauri .sig file (up to 16 KiB).')
  const encoded = signature.trim(), bytes = decodeBase64(encoded, 'Signature')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('Signature is not a UTF-8 Minisign document.') }
  const lines = text.trimEnd().split(/\r?\n/)
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ')) throw new Error('Signature is not a complete Tauri Minisign document.')
  const primary = decodeBase64(lines[1], 'Artifact signature'), global = decodeBase64(lines[3], 'Comment signature')
  if (primary.length !== 74 || !['Ed', 'ED'].includes(primary.subarray(0, 2).toString('ascii')) || global.length !== 64) throw new Error('Signature contains invalid Minisign signature lengths or algorithm.')
  const fields = new Map()
  for (const field of lines[2].slice('trusted comment: '.length).split('\t')) {
    const match = /^(timestamp|file|version):(.*)$/.exec(field)
    if (!match || fields.has(match[1])) throw new Error('Signature trusted comment contains invalid or duplicate metadata.')
    fields.set(match[1], match[2])
  }
  if (!/^\d+$/.test(fields.get('timestamp') ?? '') || fields.get('file') !== filename) throw new Error('Signature filename does not match the installer. Use its original signed filename.')
  if (!fields.has('version')) throw new Error('Signature has no signed app version. Sign again using tauri signer sign --app-version VERSION.')
  if (fields.get('version') !== semver(expectedVersion)) throw new Error('Signature app version does not match the manifest version.')
  return encoded
}
function downloadUrl(value, filename) {
  let url
  try { url = new URL(value) } catch { throw new Error('Provide a complete HTTPS installer URL.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Installer URL must use HTTPS without credentials or a fragment.')
  let name
  try { name = decodeURIComponent(url.pathname.split('/').pop()) } catch { throw new Error('Installer URL has invalid percent encoding.') }
  if (name !== filename) throw new Error('Installer URL must end with the same signed installer filename.')
  return url.toString()
}
function publicationDate(value) {
  if (value === undefined) return new Date().toISOString()
  const match = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-](\d\d):(\d\d))$/.exec(value)
  if (!match) throw new Error('Date must be a valid RFC 3339 date.')
  const [, year, month, day, hour, minute, second, offsetHour = '0', offsetMinute = '0'] = match.map(part => part === undefined ? part : Number(part))
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const parsed = new Date(value)
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59 || !Number.isFinite(parsed.getTime())) throw new Error('Date must be a valid RFC 3339 date.')
  return parsed.toISOString()
}
async function installerFile(path) {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 64) throw new Error('Installer must be an existing Windows executable file.')
    const header = Buffer.alloc(64)
    await file.read(header, 0, header.length, 0)
    const offset = header.readUInt32LE(0x3c)
    if (header.subarray(0, 2).toString('ascii') !== 'MZ' || offset < 64 || offset > 1024 * 1024 || offset + 4 > info.size) throw new Error('Installer does not have a valid Windows PE header.')
    const pe = Buffer.alloc(4)
    await file.read(pe, 0, 4, offset)
    if (!pe.equals(Buffer.from([80, 69, 0, 0]))) throw new Error('Installer does not have a valid Windows PE header.')
  } finally { await file.close() }
}
export async function createUpdateManifest({ artifact, signature, version, url, output, notesFile, date }) {
  if (![artifact, version, url, output].every(value => typeof value === 'string' && value.length)) throw new Error('Required options: --artifact, --version, --url, --output.')
  semver(version)
  const filename = basename(artifact)
  if (!/_x64-setup\.exe$/i.test(filename) || /[\t\r\n]/.test(filename)) throw new Error('Use the Windows x64 NSIS artifact named *_x64-setup.exe, rather than the portable app executable.')
  await installerFile(artifact)
  const signaturePath = signature || artifact + '.sig', signatureInfo = await stat(signaturePath)
  if (!signatureInfo.isFile() || signatureInfo.size > 16384) throw new Error('Tauri signature file must be a regular file up to 16 KiB.')
  const signed = signatureMetadata(await readFile(signaturePath, 'utf8'), version, filename)
  const packageUrl = downloadUrl(url, filename)
  let notes = ''
  if (notesFile) {
    const notesInfo = await stat(notesFile)
    if (!notesInfo.isFile() || notesInfo.size > 65536) throw new Error('Release notes must be a UTF-8 file up to 64 KiB.')
    try { notes = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(notesFile)) }
    catch { throw new Error('Release notes must contain valid UTF-8 text.') }
  }
  const manifest = { version, notes, pub_date: publicationDate(date), platforms: { 'windows-x86_64': { url: packageUrl, signature: signed } } }
  await mkdir(dirname(resolve(output)), { recursive: true })
  try { await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }) }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Output already exists and was left unchanged. Choose a new output filename.'); throw error }
  return manifest
}
export function parseArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return null
  const result = {}, names = new Map([['--artifact', 'artifact'], ['--signature', 'signature'], ['--version', 'version'], ['--url', 'url'], ['--output', 'output'], ['--notes-file', 'notesFile'], ['--date', 'date']])
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]), value = args[index + 1]
    if (!name || Object.hasOwn(result, name) || !value || value.startsWith('--')) throw new Error('Invalid or duplicate options. Run with --help for usage.')
    result[name] = value
  }
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const run = async () => {
    const options = parseArguments(process.argv.slice(2))
    if (!options) { process.stdout.write(HELP + '\n'); return }
    await createUpdateManifest(options)
    process.stdout.write(`Created update manifest: ${resolve(options.output)}\n`)
  }
  void run().catch(error => { process.stderr.write(`Cannot create update manifest: ${error.message}\n`); process.exitCode = 1 })
}

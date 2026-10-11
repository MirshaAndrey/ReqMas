import { RequestValidationError } from './prepareRequest.ts'
export const MAX_RESPONSE_BYTES = 100 * 1024 * 1024
export async function readResponseBytes(response: globalThis.Response, signal: AbortSignal, limit = MAX_RESPONSE_BYTES): Promise<Uint8Array> {
  signal.throwIfAborted()
  const tooLarge = () => new RequestValidationError(`Response exceeds the ${Math.round(limit / 1024 / 1024)} MiB size limit.`)
  const length = response.headers.get('content-length')
  if (length && /^\d+$/.test(length) && Number(length) > limit) { await response.body?.cancel(); throw tooLarge() }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw tooLarge() }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock() }
}

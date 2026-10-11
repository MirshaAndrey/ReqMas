export function bytesBase64(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return btoa(text)
}

export function decodeResponseText(bytes: Uint8Array, contentType = ''): string {
  const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  try { return new TextDecoder((charset?.[1] ?? charset?.[2] ?? 'utf-8').trim()).decode(bytes) }
  catch { return new TextDecoder('utf-8').decode(bytes) }
}

export function isBinaryResponse(bytes: Uint8Array, contentType = ''): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase()
  if (type.startsWith('text/') || /(?:json|xml|javascript|yaml|x-www-form-urlencoded|graphql)/.test(type)) return false
  if (/^(?:image|audio|video|font)\//.test(type) || /(?:octet-stream|pdf|zip|compressed|protobuf|wasm)/.test(type)) return true
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return true }
  return bytes.some(byte => byte < 32 && ![9, 10, 13].includes(byte))
}

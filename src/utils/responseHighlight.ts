export type TokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punctuation' | 'text'
export type Token = { text: string; kind: TokenKind }

// Keep every character intact; tokens are rendered as React text, never HTML.
export function highlightJsonLine(line: string): Token[] {
  const tokens: Token[] = []
  const pattern = /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}[\]:,]/g
  let offset = 0
  for (const match of line.matchAll(pattern)) {
    if (match.index > offset) tokens.push({ text: line.slice(offset, match.index), kind: 'text' })
    const text = match[0]
    const kind: TokenKind = text.startsWith('"')
      ? line.slice(match.index + text.length).trimStart().startsWith(':') ? 'key' : 'string'
      : text === 'null' ? 'null'
      : text === 'true' || text === 'false' ? 'boolean'
      : /^-?\d/.test(text) ? 'number' : 'punctuation'
    tokens.push({ text, kind })
    offset = match.index + text.length
  }
  if (offset < line.length) tokens.push({ text: line.slice(offset), kind: 'text' })
  return tokens
}

export function highlightHeaderLine(line: string): Token[] {
  const colon = line.indexOf(':')
  return colon < 0 ? [{ text: line, kind: 'text' }] : [
    { text: line.slice(0, colon), kind: 'key' },
    { text: ':', kind: 'punctuation' },
    { text: line.slice(colon + 1), kind: 'string' },
  ]
}


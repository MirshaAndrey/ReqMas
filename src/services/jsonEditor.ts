// Temporarily quote variables outside JSON strings, preserving template syntax on formatting.
export function formatJsonTemplate(input: string): string {
  let prefix = '__REQMAS_VARIABLE_'; while (input.includes(prefix)) prefix += '_'
  const variables: string[] = []; let text = ''; let inString = false; let escaped = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (!inString && input.slice(i, i + 2) === '{{') {
      const end = input.indexOf('}}', i + 2); if (end < 0) throw new Error('Unclosed variable template')
      const token = input.slice(i, end + 2); variables.push(token); text += JSON.stringify(prefix + (variables.length - 1)); i = end + 1; continue
    }
    text += c
    if (inString) { if (!escaped && c === '"') inString = false; escaped = !escaped && c === '\\' }
    else if (c === '"') inString = true
  }
  let output = formatResponseJson(text)
  variables.forEach((variable, i) => { output = output.replaceAll(JSON.stringify(prefix + i), variable) })
  return output
}
import { formatResponseJson } from './responseView.ts'

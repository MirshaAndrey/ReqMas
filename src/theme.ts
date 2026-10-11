import { read } from './storage/database'

export type Theme = 'system' | 'light' | 'dark'

export function getTheme(): Theme {
  const saved = read<string>('theme', 'system')
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

export function applyTheme(theme: Theme) {
  const resolved = theme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : theme
  document.documentElement.dataset.theme = resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#090e09' : '#f2f5ed')
}

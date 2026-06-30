/**
 * File utilities inspired by VS Code's language detection and path handling.
 * @see https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/languages/modesRegistry.ts
 */

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  conf: 'nginx',
  nginx: 'nginx',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  sql: 'sql',
  toml: 'toml',
  ini: 'ini',
  env: 'ini',
  dockerfile: 'dockerfile',
  log: 'log',
  txt: 'plaintext',
}

const FILENAME_LANGUAGE_MAP: Record<string, string> = {
  '.bashrc': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.gitignore': 'plaintext',
  '.env': 'ini',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'nginx.conf': 'nginx',
}

export function getLanguageFromPath(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (FILENAME_LANGUAGE_MAP[name]) {
    return FILENAME_LANGUAGE_MAP[name]
  }

  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined
  if (ext && EXTENSION_LANGUAGE_MAP[ext]) {
    return EXTENSION_LANGUAGE_MAP[ext]
  }

  return 'plaintext'
}

export function getFileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function getParentPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized.slice(0, 2)
    const rest = normalized.slice(3)
    const parts = rest.split('/').filter(Boolean)
    if (parts.length <= 1) return `${drive}/`
    return `${drive}/${parts.slice(0, -1).join('/')}`
  }
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 1) return '/'
  return '/' + parts.slice(0, -1).join('/')
}

export function joinPath(base: string, name: string): string {
  const normalized = base.endsWith('/') ? base.slice(0, -1) : base
  return `${normalized}/${name}`.replace(/\/+/g, '/')
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

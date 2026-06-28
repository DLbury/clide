/**
 * 本地编辑缓存（草稿 / 非 SSH 会话）。
 * SSH 远程文件通过 Tauri terminal_read_file / terminal_write_file 读写。
 */

import type { FileItem } from './types'
import { joinPath, getParentPath } from './file-utils'

/** 空树：连接真实服务器后由 SFTP 列表填充 */
export const EMPTY_FILE_TREE: FileItem[] = []

/** 本地编辑缓存（用户在本机新建/修改、尚未同步到远程的文件） */
const localFileContents: Record<string, string> = {}

export function readFileContent(path: string): string {
  if (path in localFileContents) {
    return localFileContents[path]
  }
  return `# 文件尚未加载\n# 路径: ${path}`
}

export function writeFileContent(path: string, content: string): void {
  localFileContents[path] = content
}

export function clearLocalFileContents(): void {
  for (const key of Object.keys(localFileContents)) {
    delete localFileContents[key]
  }
}

let nextFileId = 1000
function newFileId() {
  return `fs-${nextFileId++}`
}

export function getUniqueDirectoryName(
  siblings: FileItem[] | undefined,
  baseName = '新建文件夹'
): string {
  if (!siblings?.some(item => item.name === baseName)) return baseName
  let index = 2
  while (siblings.some(item => item.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

export function setDirectoryExpanded(
  items: FileItem[],
  id: string,
  expanded: boolean
): FileItem[] {
  const walk = (nodes: FileItem[]): FileItem[] =>
    nodes.map(item => {
      if (item.id === id) {
        return { ...item, isExpanded: expanded }
      }
      if (item.children) {
        return { ...item, children: walk(item.children) }
      }
      return item
    })
  return walk(items)
}

export function createDirectory(
  items: FileItem[],
  parentPath: string,
  folderName: string
): FileItem[] {
  const trimmed = folderName.trim()
  if (!trimmed) return items

  const parent = findFileItem(items, parentPath)
  if (!parent || parent.type !== 'directory') return items

  const name = getUniqueDirectoryName(parent.children, trimmed)
  const path = joinPath(parentPath, name)
  const newFolder: FileItem = {
    id: newFileId(),
    name,
    path,
    type: 'directory',
    isExpanded: false,
    children: [],
  }

  const add = (nodes: FileItem[]): FileItem[] =>
    nodes.map(item => {
      if (item.path === parentPath) {
        return {
          ...item,
          isExpanded: true,
          children: [...(item.children ?? []), newFolder],
        }
      }
      if (item.children) {
        return { ...item, children: add(item.children) }
      }
      return item
    })

  return add(items)
}

export function getUniqueFileName(
  siblings: FileItem[] | undefined,
  baseName = '新建文件.txt'
): string {
  if (!siblings?.some(item => item.name === baseName)) return baseName
  let index = 2
  while (siblings.some(item => item.name === `${baseName.replace(/\.\w+$/, '')} ${index}${baseName.match(/\.\w+$/)?.[0] ?? ''}`)) {
    index += 1
  }
  const ext = baseName.match(/\.\w+$/)?.[0] ?? ''
  const stem = baseName.replace(/\.\w+$/, '')
  return `${stem} ${index}${ext}`
}

export function createFile(
  items: FileItem[],
  parentPath: string,
  fileName: string,
  content = ''
): FileItem[] {
  const trimmed = fileName.trim()
  if (!trimmed) return items

  const parent = findFileItem(items, parentPath)
  if (!parent || parent.type !== 'directory') return items

  const name = getUniqueFileName(parent.children, trimmed)
  const path = joinPath(parentPath, name)
  writeFileContent(path, content)

  const newFile: FileItem = {
    id: newFileId(),
    name,
    path,
    type: 'file',
    size: content.length,
    modified: new Date(),
  }

  const add = (nodes: FileItem[]): FileItem[] =>
    nodes.map(item => {
      if (item.path === parentPath) {
        return {
          ...item,
          isExpanded: true,
          children: [...(item.children ?? []), newFile],
        }
      }
      if (item.children) {
        return { ...item, children: add(item.children) }
      }
      return item
    })

  return add(items)
}

export function findFileItemById(items: FileItem[], id: string): FileItem | undefined {
  for (const item of items) {
    if (item.id === id) return item
    if (item.children) {
      const found = findFileItemById(item.children, id)
      if (found) return found
    }
  }
  return undefined
}

export function toggleDirectoryExpanded(items: FileItem[], id: string): FileItem[] {
  const toggle = (nodes: FileItem[]): FileItem[] =>
    nodes.map(item => {
      if (item.id === id) {
        return { ...item, isExpanded: !item.isExpanded }
      }
      if (item.children) {
        return { ...item, children: toggle(item.children) }
      }
      return item
    })
  return toggle(items)
}

export function setAllExpanded(items: FileItem[], expanded: boolean): FileItem[] {
  const walk = (nodes: FileItem[]): FileItem[] =>
    nodes.map(item => ({
      ...item,
      isExpanded: item.type === 'directory' ? expanded : item.isExpanded,
      children: item.children ? walk(item.children) : undefined,
    }))
  return walk(items)
}

function remapPathPrefix(path: string, oldPrefix: string, newPrefix: string): string {
  if (path === oldPrefix) return newPrefix
  if (path.startsWith(`${oldPrefix}/`)) {
    return `${newPrefix}${path.slice(oldPrefix.length)}`
  }
  return path
}

export function renameFileItem(
  items: FileItem[],
  itemPath: string,
  newName: string
): FileItem[] {
  const trimmed = newName.trim()
  if (!trimmed || trimmed.includes('/')) return items

  const newPath = joinPath(getParentPath(itemPath), trimmed)

  const walk = (nodes: FileItem[]): FileItem[] =>
    nodes.map(item => {
      const remappedPath = remapPathPrefix(item.path, itemPath, newPath)
      const next: FileItem = {
        ...item,
        path: remappedPath,
        name: item.path === itemPath ? trimmed : item.name,
        children: item.children ? walk(item.children) : undefined,
      }
      if (item.type === 'file' && item.path in localFileContents && item.path !== remappedPath) {
        localFileContents[remappedPath] = localFileContents[item.path]
        delete localFileContents[item.path]
      }
      return next
    })

  return walk(items)
}

export function findFileItem(items: FileItem[], path: string): FileItem | undefined {
  for (const item of items) {
    if (item.path === path) return item
    if (item.children) {
      const found = findFileItem(item.children, path)
      if (found) return found
    }
  }
  return undefined
}

export function cloneFileTree(items: FileItem[]): FileItem[] {
  return JSON.parse(JSON.stringify(items))
}

/**
 * Editor service — manages open editor models similar to VS Code's IEditorService.
 * @see https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/editor/common/editorService.ts
 */

import type { OpenFile } from './types'
import { getFileName, getLanguageFromPath } from './file-utils'

export interface EditorModel {
  id: string
  path: string
  name: string
  content: string
  originalContent: string
  language: string
  isModified: boolean
  isPinned: boolean
}

export function createEditorModel(
  path: string,
  content: string,
  options?: { id?: string; pinned?: boolean }
): EditorModel {
  return {
    id: options?.id ?? `editor-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    path,
    name: getFileName(path),
    content,
    originalContent: content,
    language: getLanguageFromPath(path),
    isModified: false,
    isPinned: options?.pinned ?? false,
  }
}

export function openEditorModel(
  models: EditorModel[],
  path: string,
  content: string
): { models: EditorModel[]; activeId: string; isNew: boolean } {
  const existing = models.find(m => m.path === path)
  if (existing) {
    return { models, activeId: existing.id, isNew: false }
  }

  const model = createEditorModel(path, content)
  return {
    models: [...models, model],
    activeId: model.id,
    isNew: true,
  }
}

export function updateEditorContent(
  models: EditorModel[],
  id: string,
  content: string
): EditorModel[] {
  return models.map(m =>
    m.id === id
      ? { ...m, content, isModified: content !== m.originalContent }
      : m
  )
}

export function saveEditorModel(models: EditorModel[], id: string): EditorModel[] {
  return models.map(m =>
    m.id === id
      ? { ...m, originalContent: m.content, isModified: false }
      : m
  )
}

/** 远程文件加载完成后替换编辑器内容 */
export function setEditorLoadedContent(
  models: EditorModel[],
  path: string,
  content: string
): EditorModel[] {
  return models.map(m =>
    m.path === path
      ? { ...m, content, originalContent: content, isModified: false }
      : m
  )
}

export function revertEditorModel(models: EditorModel[], id: string): EditorModel[] {
  return models.map(m =>
    m.id === id
      ? { ...m, content: m.originalContent, isModified: false }
      : m
  )
}

export function closeEditorModel(
  models: EditorModel[],
  id: string,
  activeId: string | null
): { models: EditorModel[]; activeId: string | null } {
  const index = models.findIndex(m => m.id === id)
  if (index === -1) return { models, activeId }

  const next = models.filter(m => m.id !== id)
  if (activeId !== id) return { models: next, activeId }

  const newActive = next[Math.min(index, next.length - 1)]?.id ?? null
  return { models: next, activeId: newActive }
}

export function editorModelToOpenFile(model: EditorModel): OpenFile {
  return {
    id: model.id,
    path: model.path,
    name: model.name,
    content: model.content,
    language: model.language,
    isModified: model.isModified,
  }
}

export function openFileToEditorModel(file: OpenFile): EditorModel {
  return {
    id: file.id,
    path: file.path,
    name: file.name,
    content: file.content,
    originalContent: file.content,
    language: file.language,
    isModified: file.isModified,
    isPinned: false,
  }
}

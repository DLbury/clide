'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { X, Circle, Save, RotateCcw, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppTheme } from '@/hooks/use-app-theme'
import type { OpenFile } from '@/lib/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

interface EditorPaneProps {
  files: OpenFile[]
  activeFileId?: string | null
  onFileSave: (file: OpenFile) => void
  onFileClose: (fileId: string) => void
  onFileChange: (fileId: string, content: string) => void
  onActiveFileChange?: (fileId: string) => void
  onFileRevert?: (fileId: string) => void
}

export function EditorPane({
  files,
  activeFileId: controlledActiveId,
  onFileSave,
  onFileClose,
  onFileChange,
  onActiveFileChange,
  onFileRevert,
}: EditorPaneProps) {
  const { monacoTheme } = useAppTheme()
  const [internalActiveId, setInternalActiveId] = useState<string | null>(files[0]?.id ?? null)
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)

  const activeFileId = controlledActiveId ?? internalActiveId
  const activeFile = files.find(f => f.id === activeFileId)
  const pendingFile = files.find(f => f.id === pendingCloseId)

  useEffect(() => {
    if (files.length > 0 && !files.find(f => f.id === activeFileId)) {
      const nextId = files[0].id
      setInternalActiveId(nextId)
      onActiveFileChange?.(nextId)
    }
    if (files.length === 0) {
      setInternalActiveId(null)
    }
  }, [files, activeFileId, onActiveFileChange])

  const setActiveFileId = useCallback(
    (id: string) => {
      setInternalActiveId(id)
      onActiveFileChange?.(id)
    },
    [onActiveFileChange]
  )

  const handleCloseRequest = useCallback(
    (fileId: string) => {
      const file = files.find(f => f.id === fileId)
      if (file?.isModified) {
        setPendingCloseId(fileId)
      } else {
        onFileClose(fileId)
      }
    },
    [files, onFileClose]
  )

  const handleSaveAndClose = useCallback(() => {
    if (pendingFile) {
      onFileSave(pendingFile)
      onFileClose(pendingFile.id)
    }
    setPendingCloseId(null)
  }, [pendingFile, onFileSave, onFileClose])

  const handleDiscardAndClose = useCallback(() => {
    if (pendingCloseId) {
      onFileClose(pendingCloseId)
    }
    setPendingCloseId(null)
  }, [pendingCloseId, onFileClose])

  if (files.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-card text-muted-foreground">
        <div className="text-center">
          <p className="text-sm">单击左侧文件打开编辑</p>
          <p className="text-xs mt-1 text-muted-foreground/70">编辑器在上 · Shell 在下</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Tab bar — VS Code editor tabs pattern */}
      <div className="flex items-center border-b border-border bg-muted/30 overflow-x-auto terminal-scrollbar">
        {files.map(file => (
          <div
            key={file.id}
            onClick={() => setActiveFileId(file.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 text-sm border-r border-border cursor-pointer group min-w-0 shrink-0',
              'hover:bg-muted/50 transition-colors',
              activeFileId === file.id && 'bg-card border-b-card -mb-px'
            )}
          >
            {file.isModified ? (
              <Circle className="w-2 h-2 fill-primary text-primary shrink-0" />
            ) : (
              <span className="w-2 shrink-0" />
            )}
            <span className="truncate max-w-36">{file.name}</span>
            <button
              onClick={e => {
                e.stopPropagation()
                handleCloseRequest(file.id)
              }}
              className="p-0.5 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Breadcrumb */}
      {activeFile && (
        <div className="flex items-center gap-1 px-3 py-1 border-b border-border text-xs text-muted-foreground bg-muted/20 overflow-x-auto">
          {activeFile.path.split('/').filter(Boolean).map((segment, i, arr) => (
            <span key={i} className="flex items-center gap-1 shrink-0">
              {i > 0 && <ChevronRight className="w-3 h-3" />}
              <span className={i === arr.length - 1 ? 'text-foreground' : ''}>{segment}</span>
            </span>
          ))}
        </div>
      )}

      {/* Monaco editor */}
      {activeFile && (
        <div className="flex-1 overflow-hidden select-text-region">
          <MonacoEditor
            key={monacoTheme}
            height="100%"
            language={activeFile.language}
            value={activeFile.content}
            theme={monacoTheme}
            onChange={value => onFileChange(activeFile.id, value ?? '')}
            options={{
              minimap: { enabled: true },
              fontSize: 13,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'off',
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              padding: { top: 8 },
            }}
            onMount={(editor, monaco) => {
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                onFileSave(activeFile)
              })
            }}
          />
        </div>
      )}

      {/* Status bar */}
      {activeFile && (
        <div className="flex items-center justify-between px-3 py-1 border-t border-border text-xs text-muted-foreground bg-muted/30">
          <span>{activeFile.language}</span>
          <div className="flex items-center gap-3">
            <span>{activeFile.content.split('\n').length} 行</span>
            <span>UTF-8</span>
            <span>LF</span>
            {activeFile.isModified && (
              <>
                <button
                  onClick={() => onFileRevert?.(activeFile.id)}
                  className="flex items-center gap-1 hover:text-foreground transition-colors"
                  title="撤销更改"
                >
                  <RotateCcw className="w-3 h-3" />
                  撤销
                </button>
                <button
                  onClick={() => onFileSave(activeFile)}
                  className="flex items-center gap-1 text-primary hover:underline"
                >
                  <Save className="w-3 h-3" />
                  保存
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <AlertDialog open={!!pendingCloseId} onOpenChange={open => !open && setPendingCloseId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>保存更改？</AlertDialogTitle>
            <AlertDialogDescription>
              文件 &quot;{pendingFile?.name}&quot; 有未保存的更改。是否在关闭前保存？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDiscardAndClose}>不保存</AlertDialogCancel>
            <AlertDialogAction onClick={handleSaveAndClose}>保存</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

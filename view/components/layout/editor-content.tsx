'use client'

import dynamic from 'next/dynamic'
import { useCallback, useRef } from 'react'
import type { OpenFile } from '@/lib/types'
import { useAppTheme } from '@/hooks/use-app-theme'
import type { editor as MonacoEditorType } from 'monaco-editor'
import type * as Monaco from 'monaco-editor'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

interface EditorContentProps {
  file: OpenFile
  onChange: (content: string) => void
  onSave: () => void
}

export function EditorContent({ file, onChange, onSave }: EditorContentProps) {
  const { monacoTheme } = useAppTheme()
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const handleMount = useCallback(
    (editor: MonacoEditorType.IStandaloneCodeEditor, monaco: typeof Monaco) => {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSaveRef.current()
      })
    },
    []
  )

  const handleKeyDownCapture = useCallback((event: React.KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
    if (event.shiftKey || event.altKey) return
    event.preventDefault()
    event.stopPropagation()
    onSaveRef.current()
  }, [])

  return (
    <div
      className="h-full flex flex-col bg-card select-text-region"
      onKeyDownCapture={handleKeyDownCapture}
    >
      <div className="flex-1 overflow-hidden">
        <MonacoEditor
          key={`${file.id}:${monacoTheme}`}
          height="100%"
          language={file.language}
          value={file.content}
          theme={monacoTheme}
          onChange={value => onChange(value ?? '')}
          onMount={handleMount}
          options={{
            minimap: { enabled: true },
            fontSize: 13,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'off',
            bracketPairColorization: { enabled: true },
            smoothScrolling: true,
            padding: { top: 8 },
          }}
        />
      </div>
    </div>
  )
}

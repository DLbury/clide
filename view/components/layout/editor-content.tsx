'use client'

import dynamic from 'next/dynamic'
import { useCallback } from 'react'
import type { OpenFile } from '@/lib/types'
import { useAppTheme } from '@/hooks/use-app-theme'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

interface EditorContentProps {
  file: OpenFile
  onChange: (content: string) => void
  onSave: () => void
}

export function EditorContent({ file, onChange, onSave }: EditorContentProps) {
  const { monacoTheme } = useAppTheme()
  const handleMount = useCallback(
    (
      editor: { addCommand: (keybinding: number, handler: () => void) => void },
      monaco: { KeyMod: { CtrlCmd: number }; KeyCode: { KeyS: number } }
    ) => {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave())
    },
    [onSave]
  )

  return (
    <div className="h-full flex flex-col bg-card select-text-region">
      <div className="flex-1 overflow-hidden">
        <MonacoEditor
          key={monacoTheme}
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

'use client'

import { useCallback, useRef, useEffect } from 'react'
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
  DockviewApi,
  IDockviewPanelHeaderProps,
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { Terminal, FolderOpen, FileCode, Sparkles, X } from 'lucide-react'
import { TerminalPanel } from './terminal-panel'
import { SftpPanel } from './sftp-panel'
import { EditorPanel } from './editor-panel'
import { AiChatPanel } from './ai-chat-panel'
import type { TerminalLine, OpenFile, ChatMessage, FileItem, Session } from '@/lib/types'

// Panel Props types
interface TerminalPanelData {
  type: 'terminal'
  shellId: string
  sessionName: string
  history: TerminalLine[]
  onCommand: (shellId: string, command: string) => void
}

interface SftpPanelData {
  type: 'sftp'
  sessionId: string
  onFileOpen: (file: FileItem) => void
}

interface EditorPanelData {
  type: 'editor'
  file: OpenFile
  onSave: (file: OpenFile) => void
  onClose: () => void
  onChange: (content: string) => void
}

interface AiChatPanelData {
  type: 'ai-chat'
  messages: ChatMessage[]
  isThinking: boolean
  onSendMessage: (message: string) => void
  onExecuteCommand: (command: string) => void
}

type PanelData = TerminalPanelData | SftpPanelData | EditorPanelData | AiChatPanelData

// Panel content component
function PanelContent({ params }: IDockviewPanelProps<PanelData>) {
  const data = params
  
  switch (data.type) {
    case 'terminal':
      return (
        <TerminalPanel
          shellId={data.shellId}
          sessionName={data.sessionName}
          history={data.history}
          onCommand={data.onCommand}
        />
      )
    case 'sftp':
      return (
        <SftpPanel
          sessionId={data.sessionId}
          onFileOpen={data.onFileOpen}
        />
      )
    case 'editor':
      return (
        <EditorPanel
          file={data.file}
          onSave={data.onSave}
          onClose={data.onClose}
          onChange={data.onChange}
        />
      )
    case 'ai-chat':
      return (
        <AiChatPanel
          messages={data.messages}
          isThinking={data.isThinking}
          onSendMessage={data.onSendMessage}
          onExecuteCommand={data.onExecuteCommand}
        />
      )
    default:
      return <div className="p-4 text-muted-foreground">未知面板类型</div>
  }
}

// Custom tab header
function TabHeader(props: IDockviewPanelHeaderProps<PanelData>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = props as any
  const data = p.params?.params as PanelData | undefined
  const api = p.params?.api
  const title = p.title || ''

  if (!data) return null
  
  const getIcon = () => {
    switch (data.type) {
      case 'terminal':
        return <Terminal className="w-3.5 h-3.5" />
      case 'sftp':
        return <FolderOpen className="w-3.5 h-3.5" />
      case 'editor':
        return <FileCode className="w-3.5 h-3.5" />
      case 'ai-chat':
        return <Sparkles className="w-3.5 h-3.5" />
    }
  }

  const getTitle = () => {
    switch (data.type) {
      case 'terminal':
        return title || '终端'
      case 'sftp':
        return 'SFTP'
      case 'editor':
        return (data as EditorPanelData).file?.name || '编辑器'
      case 'ai-chat':
        return 'AI 助手'
    }
  }

  const isModified = data.type === 'editor' && (data as EditorPanelData).file?.isModified

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 h-full min-w-0">
      <span className="text-muted-foreground shrink-0">{getIcon()}</span>
      <span className="truncate text-xs">{getTitle()}</span>
      {isModified && (
        <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          api.close()
        }}
        className="ml-auto p-0.5 rounded hover:bg-muted/80 opacity-60 hover:opacity-100 transition-opacity shrink-0"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}

// Dockview component definition
const components = {
  panel: PanelContent,
}

const tabComponents = {
  tab: TabHeader,
}

interface DockLayoutProps {
  session: Session
  onApiReady: (api: DockviewApi) => void
  terminalHistory: Record<string, TerminalLine[]>
  onCommand: (shellId: string, command: string) => void
  onFileOpen: (file: FileItem) => void
  openFiles: OpenFile[]
  onFileSave: (file: OpenFile) => void
  onFileClose: (fileId: string) => void
  onFileChange: (fileId: string, content: string) => void
  aiMessages: ChatMessage[]
  aiThinking: boolean
  onAiMessage: (message: string) => void
  onAiExecuteCommand: (command: string) => void
}

export function DockLayout({
  session,
  onApiReady,
  terminalHistory,
  onCommand,
  onFileOpen,
  openFiles,
  onFileSave,
  onFileClose,
  onFileChange,
  aiMessages,
  aiThinking,
  onAiMessage,
  onAiExecuteCommand,
}: DockLayoutProps) {
  const apiRef = useRef<DockviewApi | null>(null)
  const initializedRef = useRef(false)

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    onApiReady(event.api)

    if (initializedRef.current) return
    initializedRef.current = true

    // SSH connection: default layout with SFTP on left, Terminal on right
    if (session.type === 'ssh') {
      // Add SFTP panel
      event.api.addPanel({
        id: `sftp-${session.id}`,
        component: 'panel',
        tabComponent: 'tab',
        title: 'SFTP',
        params: {
          type: 'sftp',
          sessionId: session.id,
          onFileOpen,
        } as SftpPanelData,
      })

      // Add Terminal panel to the right
      const shellId = `shell-${session.id}-1`
      event.api.addPanel({
        id: `terminal-${shellId}`,
        component: 'panel',
        tabComponent: 'tab',
        title: `终端 1`,
        params: {
          type: 'terminal',
          shellId,
          sessionName: session.name,
          history: terminalHistory[shellId] || [],
          onCommand,
        } as TerminalPanelData,
        position: { direction: 'right' },
      })

      // Add AI Chat panel to the far right
      event.api.addPanel({
        id: `ai-chat-${session.id}`,
        component: 'panel',
        tabComponent: 'tab',
        title: 'AI 助手',
        params: {
          type: 'ai-chat',
          messages: aiMessages,
          isThinking: aiThinking,
          onSendMessage: onAiMessage,
          onExecuteCommand: onAiExecuteCommand,
        } as AiChatPanelData,
        position: { direction: 'right' },
      })
    } else {
      // Non-SSH: just terminal
      const shellId = `shell-${session.id}-1`
      event.api.addPanel({
        id: `terminal-${shellId}`,
        component: 'panel',
        tabComponent: 'tab',
        title: `终端 1`,
        params: {
          type: 'terminal',
          shellId,
          sessionName: session.name,
          history: terminalHistory[shellId] || [],
          onCommand,
        } as TerminalPanelData,
      })

      // Add AI Chat
      event.api.addPanel({
        id: `ai-chat-${session.id}`,
        component: 'panel',
        tabComponent: 'tab',
        title: 'AI 助手',
        params: {
          type: 'ai-chat',
          messages: aiMessages,
          isThinking: aiThinking,
          onSendMessage: onAiMessage,
          onExecuteCommand: onAiExecuteCommand,
        } as AiChatPanelData,
        position: { direction: 'right' },
      })
    }
  }, [session, onApiReady, onFileOpen, terminalHistory, onCommand, aiMessages, aiThinking, onAiMessage, onAiExecuteCommand])

  // Update panel params when data changes
  useEffect(() => {
    if (!apiRef.current) return

    // Update terminal histories
    Object.entries(terminalHistory).forEach(([shellId, history]) => {
      const panel = apiRef.current?.getPanel(`terminal-${shellId}`)
      if (panel) {
        panel.api.updateParameters({
          type: 'terminal',
          shellId,
          sessionName: session.name,
          history,
          onCommand,
        } as TerminalPanelData)
      }
    })

    // Update AI chat
    const aiPanel = apiRef.current?.getPanel(`ai-chat-${session.id}`)
    if (aiPanel) {
      aiPanel.api.updateParameters({
        type: 'ai-chat',
        messages: aiMessages,
        isThinking: aiThinking,
        onSendMessage: onAiMessage,
        onExecuteCommand: onAiExecuteCommand,
      } as AiChatPanelData)
    }
  }, [terminalHistory, session, onCommand, aiMessages, aiThinking, onAiMessage, onAiExecuteCommand])

  // Handle open files changes
  useEffect(() => {
    if (!apiRef.current) return

    openFiles.forEach(file => {
      const existingPanel = apiRef.current?.getPanel(`editor-${file.id}`)
      if (existingPanel) {
        existingPanel.api.updateParameters({
          type: 'editor',
          file,
          onSave: onFileSave,
          onClose: () => onFileClose(file.id),
          onChange: (content: string) => onFileChange(file.id, content),
        } as EditorPanelData)
      } else {
        // Add new editor panel
        apiRef.current?.addPanel({
          id: `editor-${file.id}`,
          component: 'panel',
          tabComponent: 'tab',
          title: file.name,
          params: {
            type: 'editor',
            file,
            onSave: onFileSave,
            onClose: () => onFileClose(file.id),
            onChange: (content: string) => onFileChange(file.id, content),
          } as EditorPanelData,
          position: { direction: 'within' },
        })
      }
    })
  }, [openFiles, onFileSave, onFileClose, onFileChange])

  return (
    <DockviewReact
      className="h-full dockview-theme-dark"
      components={components}
      tabComponents={tabComponents}
      onReady={onReady}
      singleTabMode="fullwidth"
      disableDnd={false}
      watermarkComponent={() => null}
    />
  )
}

import type { ClaudeStreamEvent } from '@/lib/claude-client'
import type { ChatMessage, ChatMessagePart, ChatTaskPart, ChatToolPart } from '@/lib/types'
import type { ToolActivityEvent } from '@/lib/runtime-sync'

/** 工具输出/单条文本最大字符数，防止巨型日志撑爆前端内存 */
const MAX_TOOL_OUTPUT_CHARS = 15_000
const MAX_REASONING_CHARS = 20_000

function truncateText(text: string | undefined, max: number): string | undefined {
  if (!text || text.length <= max) return text
  return text.slice(text.length - max)
}

function toolTaskTitle(name: string, input?: unknown): string {
  if (name === 'runShellCommand' || name === 'mcp__aiterm__runShellCommand') {
    const cmd =
      input &&
      typeof input === 'object' &&
      input !== null &&
      'command' in input &&
      typeof (input as { command?: unknown }).command === 'string'
        ? (input as { command: string }).command
        : undefined
    return cmd ? `执行: ${cmd}` : '执行 Shell 命令'
  }
  if (name === 'connectServer' || name === 'mcp__aiterm__connectServer') {
    return '连接服务器'
  }
  if (name === 'getTerminalContext' || name === 'mcp__aiterm__getTerminalContext') {
    return '读取终端上下文'
  }
  if (name === 'openRemoteBrowser' || name === 'mcp__aiterm__openRemoteBrowser') {
    return '打开远程浏览器'
  }
  if (name === 'listPortForwards' || name === 'mcp__aiterm__listPortForwards') {
    return '列出端口转发'
  }
  return name.replace(/^mcp__aiterm__/, '')
}

function shellCommandFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || input === null || !('command' in input)) {
    return undefined
  }
  const cmd = (input as { command?: unknown }).command
  return typeof cmd === 'string' ? cmd.trim() : undefined
}

/** 正文可能在 message.content 或 timeline parts 中 */
export function messageHasTextContent(message: ChatMessage): boolean {
  if (message.content?.trim()) return true
  return message.parts?.some(p => p.kind === 'text' && p.content.trim()) ?? false
}

export function messageHasRunningTools(message: ChatMessage): boolean {
  return (
    message.tools?.some(t => t.status === 'running' || t.status === 'pending') ?? false
  )
}

function upsertTask(
  tasks: ChatTaskPart[] | undefined,
  id: string,
  title: string,
  status: ChatTaskPart['status'],
  description?: string
): ChatTaskPart[] {
  const list = [...(tasks ?? [])]
  const idx = list.findIndex(t => t.id === id)
  const next: ChatTaskPart = { id, title, status, description }
  if (idx >= 0) list[idx] = { ...list[idx], ...next }
  else list.push(next)
  return list
}

function upsertTool(
  tools: ChatToolPart[] | undefined,
  patch: ChatToolPart
): ChatToolPart[] {
  const list = [...(tools ?? [])]
  const idx = list.findIndex(t => t.id === patch.id)
  if (idx >= 0) list[idx] = { ...list[idx], ...patch }
  else list.push(patch)
  return list
}

function appendPart(message: ChatMessage, part: ChatMessagePart): ChatMessage {
  if (message.role !== 'assistant') return message
  const parts = [...(message.parts ?? [])]
  const last = parts[parts.length - 1]
  if (
    last &&
    (part.kind === 'text' || part.kind === 'reasoning') &&
    last.kind === part.kind
  ) {
    parts[parts.length - 1] = { ...last, content: last.content + part.content }
  } else if (part.kind === 'tool') {
    // Avoid duplicating tool blocks in timeline.
    if (!parts.some(p => p.kind === 'tool' && p.toolId === part.toolId)) {
      parts.push(part)
    }
  } else {
    parts.push(part)
  }
  return { ...message, parts }
}

/** 回合结束时收尾：未收到 tool_result 的 MCP 工具不再显示 Running */
export function finalizeAssistantTurn(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant') return message

  const tools = message.tools?.map(tool => {
    if (tool.status === 'running' || tool.status === 'pending') {
      return { ...tool, status: 'completed' as const }
    }
    return tool
  })

  const tasks = message.tasks?.map(task =>
    task.status === 'pending' ? { ...task, status: 'completed' as const } : task
  )

  return { ...message, tools, tasks }
}

export function appendAssistantTextPart(message: ChatMessage, chunk: string): ChatMessage {
  if (!chunk) return message
  return appendPart(message, { kind: 'text', content: chunk })
}

export function applyClaudeStreamEvent(
  message: ChatMessage,
  event: ClaudeStreamEvent
): ChatMessage {
  let next = message

  const reasoningChunk = event.reasoning ?? (event.eventType === 'reasoning_delta' ? event.text : undefined)
  if (reasoningChunk) {
    const merged = (next.reasoning ?? '') + reasoningChunk
    next = {
      ...next,
      reasoning: merged.length > MAX_REASONING_CHARS ? merged.slice(merged.length - MAX_REASONING_CHARS) : merged,
    }
    next = appendPart(next, { kind: 'reasoning', content: reasoningChunk })
  }

  if (event.eventType === 'tool_start' && event.toolId && event.toolName) {
    const title = toolTaskTitle(event.toolName, event.toolInput)
    next = {
      ...next,
      tools: upsertTool(next.tools, {
        id: event.toolId,
        name: event.toolName,
        input: event.toolInput,
        status: 'running',
      }),
      tasks: upsertTask(next.tasks, event.toolId, title, 'pending'),
    }
    next = appendPart(next, { kind: 'tool', toolId: event.toolId })
  }

  if (event.eventType === 'tool_result' && event.toolId) {
    const failed = Boolean(event.toolError)
    next = {
      ...next,
      tools: upsertTool(next.tools, {
        id: event.toolId,
        name:
          next.tools?.find(t => t.id === event.toolId)?.name ?? 'tool',
        status: failed ? 'error' : 'completed',
        output: truncateText(event.toolOutput, MAX_TOOL_OUTPUT_CHARS),
        error: truncateText(event.toolError, MAX_TOOL_OUTPUT_CHARS),
      }),
      tasks: upsertTask(
        next.tasks,
        event.toolId,
        next.tasks?.find(t => t.id === event.toolId)?.title ?? '工具调用',
        failed ? 'pending' : 'completed'
      ),
    }
  }

  return next
}

/** 稳定 ID：running/completed 事件必须命中同一条工具记录 */
export function toolActivityId(activity: ToolActivityEvent): string {
  if (activity.kind === 'shell_command') {
    const cmd = (activity.command ?? activity.displayCommand ?? '').trim()
    const sess = activity.terminalSessionId ?? activity.profileId ?? 'default'
    return `activity-shell-${sess}-${cmd}`
  }
  if (activity.kind === 'connect' || activity.kind === 'disconnect') {
    return `activity-${activity.kind}-${activity.profileId ?? 'unknown'}`
  }
  return `activity-${activity.kind}-${activity.profileId ?? activity.command ?? 'unknown'}`
}

export function applyToolActivityToMessage(
  message: ChatMessage,
  activity: ToolActivityEvent
): ChatMessage {
  const activityCmd = (activity.command ?? activity.displayCommand ?? '').trim()
  const existingByCmd =
    activity.kind === 'shell_command' && activityCmd
      ? message.tools?.find(t => {
          if (t.name !== 'mcp__aiterm__runShellCommand' && t.name !== 'runShellCommand') {
            return false
          }
          const input = t.input
          if (!input || typeof input !== 'object' || input === null || !('command' in input)) {
            return false
          }
          return String((input as { command?: unknown }).command ?? '').trim() === activityCmd
        })
      : undefined
  const id = existingByCmd?.id ?? toolActivityId(activity)
  let title = activity.kind
  let description: string | undefined
  let status: ChatTaskPart['status'] = 'pending'
  let toolStatus: ChatToolPart['status'] = 'running'

  if (activity.kind === 'connect') {
    title = `连接 ${activity.profileId ?? activity.displayCommand ?? ''}`
  } else if (activity.kind === 'disconnect') {
    title = `断开 ${activity.profileId ?? ''}`
  } else if (activity.kind === 'shell_command') {
    title = toolTaskTitle('runShellCommand', { command: activity.command })
    description = activity.outputPreview
    if (activity.status === 'completed') {
      status = 'completed'
      toolStatus = 'completed'
    } else if (activity.status === 'error') {
      toolStatus = 'error'
      status = 'pending'
    }
  }

  let next: ChatMessage = {
    ...message,
    tools: upsertTool(message.tools, {
      id,
      name: activity.kind === 'shell_command' ? 'mcp__aiterm__runShellCommand' : activity.kind,
      input: activity.command
        ? { command: activity.command, profileId: activity.profileId }
        : undefined,
      output: activity.outputPreview,
      error: activity.error,
      status: toolStatus,
    }),
    tasks: upsertTask(message.tasks, id, title, status, description),
  }

  // IDE MCP 经 tool-activity 完成时，同步更新 stream-json 里 toolu_* 的 running 条目
  if (activity.kind === 'shell_command' && activityCmd) {
    next = {
      ...next,
      tools: (next.tools ?? []).map(tool => {
        if (tool.status !== 'running' && tool.status !== 'pending') return tool
        if (shellCommandFromToolInput(tool.input) !== activityCmd) return tool
        return {
          ...tool,
          status: toolStatus,
          output: activity.outputPreview ?? tool.output,
          error: activity.error ?? tool.error,
        }
      }),
    }
  }

  if (message.role === 'assistant') {
    next = appendPart(next, { kind: 'tool', toolId: id })
  }
  return next
}

export function toolStatusToUiState(
  status: ChatToolPart['status']
): 'input-streaming' | 'input-available' | 'output-available' | 'output-error' {
  switch (status) {
    case 'pending':
      return 'input-streaming'
    case 'running':
      return 'input-available'
    case 'completed':
      return 'output-available'
    case 'error':
      return 'output-error'
    default:
      return 'input-available'
  }
}

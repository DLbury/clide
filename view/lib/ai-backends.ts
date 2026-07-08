import type { AiBackend } from '@/lib/ai-settings'

export interface AiBackendMeta {
  id: AiBackend
  label: string
  description: string
  pathPlaceholder: string
  envHint: string
  supportsIdeBridge: boolean
  supportsMcpRegister: boolean
}

export const AI_BACKENDS: AiBackendMeta[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: 'Anthropic 官方 CLI，支持 IDE 桥接与 aiterm MCP 工具（远程 Shell 等）。',
    pathPlaceholder: '留空自动检测（PATH 或 ~/.claude/local/claude）',
    envHint: 'CLAUDE_CODE_PATH',
    supportsIdeBridge: true,
    supportsMcpRegister: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex CLI（codex app-server 常驻）。通过 MCP 配置扩展工具。',
    pathPlaceholder: '留空自动检测 codex（PATH / npm global）',
    envHint: 'CODEX_PATH',
    supportsIdeBridge: false,
    supportsMcpRegister: false,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    description: '开源终端 AI Agent（opencode acp 常驻）。支持 opencode.json MCP 配置。',
    pathPlaceholder: '留空自动检测 opencode（PATH / npm global）',
    envHint: 'OPENCODE_PATH',
    supportsIdeBridge: false,
    supportsMcpRegister: false,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    description: 'Cursor Agent CLI（agent acp 常驻）。需已登录 Cursor；MCP 使用 ~/.cursor/mcp.json。',
    pathPlaceholder: '留空自动检测 agent / cursor-agent',
    envHint: 'CURSOR_AGENT_PATH',
    supportsIdeBridge: false,
    supportsMcpRegister: false,
  },
]

export function getBackendMeta(id: AiBackend): AiBackendMeta {
  return AI_BACKENDS.find(b => b.id === id) ?? AI_BACKENDS[0]
}

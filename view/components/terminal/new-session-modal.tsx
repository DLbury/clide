'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  X,
  Server,
  Terminal,
  Container,
  Monitor,
  Wifi,
  Radio,
  ScreenShare,
  MonitorSmartphone,
  Plus,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Session, SessionFolder, SessionFormPayload, JumpHostConfig } from '@/lib/types'

/** 尚无分组时，提交后由父组件自动创建默认分组 */
export const DEFAULT_FOLDER_PLACEHOLDER = '__default_folder__'

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
  folders: SessionFolder[]
  defaultFolderId?: string | null
  editSession?: Session | null
  editSessionFolderId?: string | null
  onCreateSession: (payload: SessionFormPayload) => void
  onUpdateSession?: (payload: { session: Session; folderId: string }) => void
}

const protocolOptions: {
  type: Session['type']
  label: string
  icon: LucideIcon
  description: string
  defaultPort?: number
}[] = [
  { type: 'ssh', label: 'SSH', icon: Server, description: 'SSH 远程连接', defaultPort: 22 },
  { type: 'telnet', label: 'Telnet', icon: Wifi, description: 'Telnet 协议', defaultPort: 23 },
  { type: 'serial', label: '串口', icon: Radio, description: '串口/COM 连接' },
  { type: 'local', label: '本地终端', icon: Terminal, description: '打开本地 Shell' },
  { type: 'docker', label: 'Docker', icon: Container, description: '连接容器' },
  { type: 'wsl', label: 'WSL', icon: Monitor, description: 'Windows 子系统' },
  { type: 'vnc', label: 'VNC', icon: ScreenShare, description: 'VNC 远程桌面', defaultPort: 5900 },
  { type: 'rdp', label: 'RDP', icon: MonitorSmartphone, description: 'Windows 远程桌面', defaultPort: 3389 },
]

const sshAuthMethods: { value: NonNullable<JumpHostConfig['authMethod']>; label: string }[] = [
  { value: 'password', label: '密码' },
  { value: 'key', label: '密钥' },
  { value: 'none', label: '默认密钥' },
]

const baudRates = [9600, 19200, 38400, 57600, 115200]

interface JumpHopForm {
  host: string
  port: string
  user: string
  useOwnAuth: boolean
  authMethod: NonNullable<JumpHostConfig['authMethod']>
  password: string
  privateKeyPath: string
}

const emptyJumpHop = (): JumpHopForm => ({
  host: '',
  port: '22',
  user: '',
  useOwnAuth: false,
  authMethod: 'password',
  password: '',
  privateKeyPath: '',
})

function jumpConfigToForm(h: JumpHostConfig): JumpHopForm {
  return {
    host: h.host,
    port: String(h.port ?? 22),
    user: h.user ?? '',
    useOwnAuth: Boolean(h.authMethod),
    authMethod: h.authMethod ?? 'password',
    password: h.password ?? '',
    privateKeyPath: h.privateKeyPath ?? '',
  }
}

function resolveSessionJumpHosts(session: Session): JumpHostConfig[] {
  if (session.jumpHosts?.length) return session.jumpHosts
  if (session.jumpHost?.host) return [session.jumpHost]
  return []
}

function formToJumpConfig(form: JumpHopForm): JumpHostConfig | null {
  const host = form.host.trim()
  if (!host) return null
  const cfg: JumpHostConfig = {
    host,
    port: parseInt(form.port, 10) || 22,
    ...(form.user.trim() ? { user: form.user.trim() } : {}),
  }
  if (form.useOwnAuth) {
    cfg.authMethod = form.authMethod
    if (form.authMethod === 'password' && form.password.trim()) {
      cfg.password = form.password.trim()
    } else if (form.authMethod === 'key') {
      cfg.privateKeyPath = form.privateKeyPath.trim()
    }
  }
  return cfg
}

function resolveInitialFolderId(
  folders: SessionFolder[],
  defaultFolderId?: string | null,
  editSessionFolderId?: string | null
): string {
  if (editSessionFolderId && folders.some(f => f.id === editSessionFolderId)) {
    return editSessionFolderId
  }
  if (defaultFolderId && folders.some(f => f.id === defaultFolderId)) {
    return defaultFolderId
  }
  if (folders.length > 0) return folders[0].id
  return DEFAULT_FOLDER_PLACEHOLDER
}

export function NewSessionModal({
  isOpen,
  onClose,
  folders,
  defaultFolderId,
  editSession,
  editSessionFolderId,
  onCreateSession,
  onUpdateSession,
}: NewSessionModalProps) {
  const [selectedType, setSelectedType] = useState<Session['type']>('ssh')
  const [folderId, setFolderId] = useState(DEFAULT_FOLDER_PLACEHOLDER)
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [authMethod, setAuthMethod] = useState<Session['authMethod']>('password')
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [jumpEnabled, setJumpEnabled] = useState(false)
  const [jumpHops, setJumpHops] = useState<JumpHopForm[]>([emptyJumpHop()])
  const [serialPort, setSerialPort] = useState('/dev/ttyUSB0')
  const [baudRate, setBaudRate] = useState('115200')
  const [formError, setFormError] = useState('')
  // 仅标准认证：password / key / none

  const folderOptions = useMemo(() => {
    if (folders.length > 0) return folders
    return [{ id: DEFAULT_FOLDER_PLACEHOLDER, name: '我的会话', sessions: [], isExpanded: true }]
  }, [folders])

  useEffect(() => {
    if (!isOpen) return

    if (editSession) {
      setSelectedType(editSession.type)
      setName(editSession.name)
      setHost(editSession.host)
      setPort(editSession.port?.toString() ?? '22')
      setUser(editSession.user ?? '')
      setAuthMethod(
        editSession.authMethod ??
          (editSession.authConfig?.type === 'password-plain'
            ? 'password'
            : editSession.authConfig?.type === 'key-path'
              ? 'key'
              : 'none')
      )
      setPassword(
        editSession.password ?? editSession.authConfig?.plainPassword ?? ''
      )
      setPrivateKeyPath(
        editSession.privateKeyPath ?? editSession.authConfig?.keyPath ?? ''
      )
      const savedHops = resolveSessionJumpHosts(editSession)
      if (savedHops.length > 0) {
        setJumpEnabled(true)
        setJumpHops(savedHops.map(jumpConfigToForm))
      } else {
        setJumpEnabled(false)
        setJumpHops([emptyJumpHop()])
      }
      setSerialPort(editSession.serialPort ?? editSession.host ?? '/dev/ttyUSB0')
      setBaudRate(String(editSession.baudRate ?? 115200))
      setFolderId(resolveInitialFolderId(folders, defaultFolderId, editSessionFolderId))
      // 标准认证仅使用旧字段（authMethod/password/privateKeyPath）；忽略 authConfig（高级认证）
    } else {
      resetFormFields()
      setFolderId(resolveInitialFolderId(folders, defaultFolderId, null))
    }
    setFormError('')
  }, [isOpen, editSession, editSessionFolderId, defaultFolderId, folders])

  const handleTypeChange = (type: Session['type']) => {
    setSelectedType(type)
    const typeConfig = protocolOptions.find(t => t.type === type)
    if (typeConfig?.defaultPort) {
      setPort(typeConfig.defaultPort.toString())
    }
    if (type !== 'ssh') {
      setFormError('')
    }
  }

  const buildSessionData = (): Omit<Session, 'id' | 'status' | 'lastActive'> | null => {
    const trimmedName = name.trim()
    const trimmedHost = host.trim()
    const trimmedUser = user.trim()

    if (!trimmedName) {
      setFormError('请填写会话名称')
      return null
    }

    const baseSession = {
      name: trimmedName,
      host: trimmedHost || 'localhost',
      type: selectedType,
    }

    switch (selectedType) {
      case 'ssh': {
        if (!trimmedHost) {
          setFormError('请填写地址')
          return null
        }
        if (!port.trim()) {
          setFormError('请填写端口')
          return null
        }
        if (!trimmedUser) {
          setFormError('请填写用户名')
          return null
        }

        if (authMethod === 'key' && !privateKeyPath.trim()) {
          setFormError('密钥认证需要填写私钥路径')
          return null
        }

        const portNum = parseInt(port, 10) || 22
        const sshSession: Omit<Session, 'id' | 'status' | 'lastActive'> = {
          ...baseSession,
          host: trimmedHost,
          port: portNum,
          user: trimmedUser,
          authMethod,
        }

        if (authMethod === 'password') {
          const pw = password.trim()
          if (pw) {
            sshSession.password = pw
            sshSession.authConfig = { type: 'password-plain', plainPassword: pw }
          } else {
            // 编辑时留空表示保留 vault 中已有密码；新建留空则连接时再输入
            sshSession.authConfig = { type: 'password-plain' }
          }
        } else if (authMethod === 'key') {
          const keyPath = privateKeyPath.trim()
          sshSession.privateKeyPath = keyPath
          sshSession.authConfig = keyPath
            ? { type: 'key-path', keyPath }
            : undefined
        } else {
          sshSession.authConfig = { type: 'default-keys' }
        }

        if (jumpEnabled) {
          const configs: JumpHostConfig[] = []
          for (let i = 0; i < jumpHops.length; i++) {
            const form = jumpHops[i]
            if (form.useOwnAuth && form.authMethod === 'key' && !form.privateKeyPath.trim()) {
              setFormError(`第 ${i + 1} 跳跳板密钥认证需要填写私钥路径`)
              return null
            }
            const cfg = formToJumpConfig(form)
            if (!cfg) {
              setFormError(`第 ${i + 1} 跳跳板地址不能为空`)
              return null
            }
            configs.push(cfg)
          }
          sshSession.jumpHosts = configs
          sshSession.jumpHost = configs[0]
        }

        return sshSession
      }
      case 'telnet':
        return {
          ...baseSession,
          port: parseInt(port, 10) || 23,
          user: trimmedUser || undefined,
        }
      case 'serial':
        return {
          ...baseSession,
          host: serialPort,
          serialPort,
          baudRate: parseInt(baudRate, 10),
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
        }
      case 'vnc':
      case 'rdp':
        return {
          ...baseSession,
          port: parseInt(port, 10),
          user: trimmedUser || undefined,
        }
      default:
        return baseSession
    }
  }

  const handleSubmit = () => {
    const sessionData = buildSessionData()
    if (!sessionData) return

    const targetFolderId = folderId || DEFAULT_FOLDER_PLACEHOLDER

    if (editSession && onUpdateSession) {
      onUpdateSession({
        session: { ...editSession, ...sessionData },
        folderId: targetFolderId,
      })
    } else {
      onCreateSession({ session: sessionData, folderId: targetFolderId })
    }

    resetFormFields()
    onClose()
  }

  const resetFormFields = () => {
    setSelectedType('ssh')
    setName('')
    setHost('')
    setPort('22')
    setUser('')
    setAuthMethod('password')
    setPassword('')
    setPrivateKeyPath('')
    setJumpEnabled(false)
    setJumpHops([emptyJumpHop()])
    setSerialPort('/dev/ttyUSB0')
    setBaudRate('115200')
    setFormError('')
  }

  if (!isOpen) return null

  const isSsh = selectedType === 'ssh'
  const needsRemoteConfig = ['ssh', 'telnet', 'vnc', 'rdp'].includes(selectedType)
  const needsSerialConfig = selectedType === 'serial'
  const isEditing = Boolean(editSession)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative bg-card border border-border rounded-lg w-full max-w-2xl mx-4 shadow-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-lg font-semibold">{isEditing ? '编辑会话' : '新建会话'}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-muted rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto terminal-scrollbar">
          {/* 名称 */}
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">名称</label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例如：生产服务器"
              className="bg-input border-border"
            />
          </div>

          {/* 分组 */}
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">分组</label>
            <Select value={folderId} onValueChange={setFolderId}>
              <SelectTrigger className="w-full bg-input border-border">
                <SelectValue placeholder="选择分组" />
              </SelectTrigger>
              <SelectContent>
                {folderOptions.map(folder => (
                  <SelectItem key={folder.id} value={folder.id}>
                    {folder.name}
                    {folder.id === DEFAULT_FOLDER_PLACEHOLDER && folders.length === 0
                      ? '（将自动创建）'
                      : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {folders.length === 0 && (
              <p className="text-xs text-muted-foreground">
                尚未创建分组，保存时将自动创建「我的会话」分组。
              </p>
            )}
          </div>

          {/* 协议 */}
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">协议</label>
            <div className="grid grid-cols-4 gap-2">
              {protocolOptions.map(({ type, label, icon: Icon }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => handleTypeChange(type)}
                  className={cn(
                    'flex flex-col items-center gap-1.5 p-3 rounded-lg border transition-all text-center',
                    selectedType === type
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/50 hover:bg-muted/50'
                  )}
                >
                  <Icon
                    className={cn(
                      'w-5 h-5',
                      selectedType === type ? 'text-primary' : 'text-muted-foreground'
                    )}
                  />
                  <span
                    className={cn(
                      'font-medium text-xs',
                      selectedType === type ? 'text-primary' : 'text-foreground'
                    )}
                  >
                    {label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* SSH 专用字段 */}
          {isSsh && (
            <>
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">地址</label>
                <Input
                  value={host}
                  onChange={e => setHost(e.target.value)}
                  placeholder="IP 或域名"
                  className="bg-input border-border"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">端口</label>
                <Input
                  value={port}
                  onChange={e => setPort(e.target.value)}
                  placeholder="22"
                  inputMode="numeric"
                  className="bg-input border-border"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">用户名</label>
                <Input
                  value={user}
                  onChange={e => setUser(e.target.value)}
                  placeholder="root"
                  className="bg-input border-border"
                />
              </div>

              {isEditing && editSession && (
                <div className="space-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <label className="text-xs text-muted-foreground">连接标识 (profileId)</label>
                  <p className="font-mono text-sm break-all">{editSession.id}</p>
                  <p className="text-xs text-muted-foreground">
                    MCP 工具 runShellCommand 使用此 id；终端 PTY id 为「profileId::shellId」，二者不同。
                  </p>
                </div>
              )}

              <div className="space-y-3">
                <label className="text-sm text-muted-foreground">认证方式</label>

                {/* 标准认证方式 */}
                {(
                  <>
                    <div className="flex gap-2">
                      {sshAuthMethods.map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setAuthMethod(value)}
                          className={cn(
                            'flex-1 px-3 py-2 rounded-lg border text-sm transition-all',
                            authMethod === value
                              ? 'border-primary bg-primary/5 text-primary'
                              : 'border-border hover:border-muted-foreground/50'
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {authMethod === 'password' && (
                      <div className="space-y-2">
                        <label className="text-sm text-muted-foreground">密码</label>
                        <Input
                          type="password"
                          value={password}
                          onChange={e => setPassword(e.target.value)}
                          placeholder="SSH 登录密码（可留空，连接时再输入）"
                          className="bg-input border-border"
                          autoComplete="off"
                        />
                        <p className="text-xs text-muted-foreground">
                          {isEditing &&
                          editSession?.authMethod === 'password' &&
                          !password
                            ? '已保存为「密码认证」；密码保存在本机独立 vault，编辑时不显示明文。'
                            : '留空则在连接时弹出密码框；填写后会保存在本机，不会发给 AI。'}
                        </p>
                      </div>
                    )}

                    {authMethod === 'none' && (
                      <p className="text-xs text-muted-foreground">
                        使用 ~/.ssh 下的默认密钥；若服务器需要密码，连接时会提示输入。
                      </p>
                    )}

                    {authMethod === 'key' && (
                      <div className="space-y-2">
                        <label className="text-sm text-muted-foreground">私钥路径</label>
                        <Input
                          value={privateKeyPath}
                          onChange={e => setPrivateKeyPath(e.target.value)}
                          placeholder="~/.ssh/id_rsa"
                          className="bg-input border-border"
                        />
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="space-y-3 rounded-lg border border-border p-3">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={jumpEnabled}
                    onChange={e => setJumpEnabled(e.target.checked)}
                    className="rounded border-border"
                  />
                  <span>经跳板机连接（ProxyJump）</span>
                </label>
                {jumpEnabled && (
                  <div className="space-y-3 pl-1">
                    {jumpHops.map((hop, index) => (
                      <div
                        key={index}
                        className="space-y-3 rounded-md border border-border/60 bg-muted/10 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-muted-foreground">
                            跳板 {index + 1}
                            {index < jumpHops.length - 1 ? ' →' : ' → 目标'}
                          </span>
                          {jumpHops.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                setJumpHops(prev => prev.filter((_, i) => i !== index))
                              }
                              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                              title="移除此跳"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <Input
                          value={hop.host}
                          onChange={e =>
                            setJumpHops(prev =>
                              prev.map((h, i) =>
                                i === index ? { ...h, host: e.target.value } : h
                              )
                            )
                          }
                          placeholder="bastion.example.com"
                          className="bg-input border-border"
                        />
                        <div className="grid grid-cols-2 gap-3">
                          <Input
                            value={hop.port}
                            onChange={e =>
                              setJumpHops(prev =>
                                prev.map((h, i) =>
                                  i === index ? { ...h, port: e.target.value } : h
                                )
                              )
                            }
                            placeholder="22"
                            inputMode="numeric"
                            className="bg-input border-border"
                          />
                          <Input
                            value={hop.user}
                            onChange={e =>
                              setJumpHops(prev =>
                                prev.map((h, i) =>
                                  i === index ? { ...h, user: e.target.value } : h
                                )
                              )
                            }
                            placeholder="用户名（可选）"
                            className="bg-input border-border"
                          />
                        </div>
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={hop.useOwnAuth}
                            onChange={e =>
                              setJumpHops(prev =>
                                prev.map((h, i) =>
                                  i === index ? { ...h, useOwnAuth: e.target.checked } : h
                                )
                              )
                            }
                            className="rounded border-border"
                          />
                          <span>此跳使用独立凭据</span>
                        </label>
                        {hop.useOwnAuth && (
                          <div className="space-y-2 rounded border border-border/40 bg-muted/20 p-2">
                            <div className="flex gap-1">
                              {sshAuthMethods.map(({ value, label }) => (
                                <button
                                  key={`hop-${index}-${value}`}
                                  type="button"
                                  onClick={() =>
                                    setJumpHops(prev =>
                                      prev.map((h, i) =>
                                        i === index ? { ...h, authMethod: value } : h
                                      )
                                    )
                                  }
                                  className={cn(
                                    'flex-1 px-2 py-1 rounded border text-[11px] transition-all',
                                    hop.authMethod === value
                                      ? 'border-primary bg-primary/5 text-primary'
                                      : 'border-border'
                                  )}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                            {hop.authMethod === 'password' && (
                              <Input
                                type="password"
                                value={hop.password}
                                onChange={e =>
                                  setJumpHops(prev =>
                                    prev.map((h, i) =>
                                      i === index ? { ...h, password: e.target.value } : h
                                    )
                                  )
                                }
                                placeholder="SSH 密码"
                                className="bg-input border-border h-8 text-sm"
                                autoComplete="off"
                              />
                            )}
                            {hop.authMethod === 'key' && (
                              <Input
                                value={hop.privateKeyPath}
                                onChange={e =>
                                  setJumpHops(prev =>
                                    prev.map((h, i) =>
                                      i === index
                                        ? { ...h, privateKeyPath: e.target.value }
                                        : h
                                    )
                                  )
                                }
                                placeholder="私钥路径"
                                className="bg-input border-border h-8 text-sm"
                              />
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => setJumpHops(prev => [...prev, emptyJumpHop()])}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1.5" />
                      添加跳板（多跳链）
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      按顺序经各跳板 forward 至目标；每跳可配置独立凭据，否则与目标共用。
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

          {/* 其他远程协议 */}
          {!isSsh && needsRemoteConfig && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-2">
                  <label className="text-sm text-muted-foreground">地址</label>
                  <Input
                    value={host}
                    onChange={e => setHost(e.target.value)}
                    placeholder="主机地址"
                    className="bg-input border-border"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">端口</label>
                  <Input
                    value={port}
                    onChange={e => setPort(e.target.value)}
                    placeholder={
                      protocolOptions.find(t => t.type === selectedType)?.defaultPort?.toString() || ''
                    }
                    className="bg-input border-border"
                  />
                </div>
              </div>

              {(selectedType === 'telnet' || selectedType === 'rdp') && (
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">用户名</label>
                  <Input
                    value={user}
                    onChange={e => setUser(e.target.value)}
                    placeholder={selectedType === 'rdp' ? 'Administrator' : '用户名'}
                    className="bg-input border-border"
                  />
                </div>
              )}
            </>
          )}

          {needsSerialConfig && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">串口设备</label>
                  <Input
                    value={serialPort}
                    onChange={e => setSerialPort(e.target.value)}
                    placeholder="/dev/ttyUSB0 或 COM1"
                    className="bg-input border-border"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">波特率</label>
                  <select
                    value={baudRate}
                    onChange={e => setBaudRate(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-border bg-input text-sm"
                  >
                    {baudRates.map(rate => (
                      <option key={rate} value={rate}>
                        {rate}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">默认：8 数据位，1 停止位，无校验</p>
            </div>
          )}

          {selectedType === 'docker' && (
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">容器名称或 ID</label>
              <Input
                value={host}
                onChange={e => setHost(e.target.value)}
                placeholder="container_name 或 abc123"
                className="bg-input border-border"
              />
            </div>
          )}

          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 p-4 border-t border-border shrink-0">
          <Button variant="ghost" onClick={onClose} className="text-muted-foreground">
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {isEditing ? '保存' : '创建会话'}
          </Button>
        </div>
      </div>
    </div>
  )
}

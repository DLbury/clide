'use client'

import { useState, useRef, useEffect } from 'react'
import { 
  Save, 
  X, 
  Undo, 
  Redo, 
  Search, 
  Copy, 
  FileCode,
  Download,
  Upload,
  Settings,
  ChevronDown
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { OpenFile } from '@/lib/types'

interface FileEditorProps {
  files: OpenFile[]
  activeFileId: string | null
  onFileClose: (fileId: string) => void
  onFileSelect: (fileId: string) => void
  onFileSave: (fileId: string, content: string) => void
}

// Mock file contents
const mockFileContents: Record<string, string> = {
  '/home/dev/.bashrc': `# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac

# don't put duplicate lines or lines starting with space in the history.
HISTCONTROL=ignoreboth

# append to the history file, don't overwrite it
shopt -s histappend

# for setting history length see HISTSIZE and HISTFILESIZE in bash(1)
HISTSIZE=1000
HISTFILESIZE=2000

# Alias definitions
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias gs='git status'
alias gc='git commit'
alias gp='git push'

# Enable color support
if [ -x /usr/bin/dircolors ]; then
    test -r ~/.dircolors && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
    alias ls='ls --color=auto'
    alias grep='grep --color=auto'
fi

export PATH="$HOME/.local/bin:$PATH"
`,
  '/home/dev/projects/app.ts': `import express from 'express';
import cors from 'cors';
import { config } from './config';

const app = express();
const PORT = config.port || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(\`Server is running on port \${PORT}\`);
});

export default app;
`,
  '/home/dev/projects/config.json': `{
  "port": 3000,
  "database": {
    "host": "localhost",
    "port": 5432,
    "name": "myapp",
    "user": "admin"
  },
  "redis": {
    "host": "localhost",
    "port": 6379
  },
  "logging": {
    "level": "info",
    "format": "json"
  }
}`,
  '/etc/nginx/nginx.conf': `user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 768;
    multi_accept on;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    gzip on;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`,
  '/etc/hosts': `127.0.0.1   localhost
127.0.1.1   devserver

# The following lines are desirable for IPv6 capable hosts
::1     ip6-localhost ip6-loopback
fe00::0 ip6-localnet
ff00::0 ip6-mcastprefix
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters

# Custom hosts
192.168.1.100   api.local
192.168.1.101   db.local
`,
  '/var/www/html/index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome</title>
    <style>
        body {
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .container {
            text-align: center;
            padding: 2rem;
        }
        h1 { font-size: 3rem; margin-bottom: 1rem; }
        p { font-size: 1.2rem; opacity: 0.9; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Welcome to Nginx!</h1>
        <p>If you see this page, the nginx web server is successfully installed and working.</p>
    </div>
</body>
</html>
`,
}

function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'html':
      return 'html'
    case 'css':
      return 'css'
    case 'sh':
    case 'bash':
    case 'bashrc':
      return 'bash'
    case 'conf':
      return 'nginx'
    case 'md':
      return 'markdown'
    default:
      return 'plaintext'
  }
}

export function getFileContent(path: string): string {
  return mockFileContents[path] || `// File: ${path}\n// Content not available`
}

export function FileEditor({ files, activeFileId, onFileClose, onFileSelect, onFileSave }: FileEditorProps) {
  const [editedContents, setEditedContents] = useState<Record<string, string>>({})
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeFile = files.find(f => f.id === activeFileId)
  const content = activeFile ? (editedContents[activeFile.id] ?? activeFile.content) : ''
  const isModified = activeFile ? editedContents[activeFile.id] !== undefined && editedContents[activeFile.id] !== activeFile.content : false

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [activeFileId])

  const handleContentChange = (newContent: string) => {
    if (activeFile) {
      setEditedContents(prev => ({
        ...prev,
        [activeFile.id]: newContent
      }))
    }
  }

  const handleSave = () => {
    if (activeFile && editedContents[activeFile.id] !== undefined) {
      onFileSave(activeFile.id, editedContents[activeFile.id])
      setEditedContents(prev => {
        const newContents = { ...prev }
        delete newContents[activeFile.id]
        return newContents
      })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      setShowSearch(true)
    }
  }

  const lines = content.split('\n')

  if (files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <div className="text-center text-muted-foreground">
          <FileCode className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>双击文件打开编辑</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-background font-mono text-sm overflow-hidden">
      {/* Tab Bar */}
      <div className="flex items-center border-b border-border bg-muted/30 overflow-x-auto terminal-scrollbar">
        {files.map(file => {
          const fileIsModified = editedContents[file.id] !== undefined && editedContents[file.id] !== file.content
          return (
            <div
              key={file.id}
              className={cn(
                "flex items-center gap-2 px-3 py-2 border-r border-border cursor-pointer min-w-0 shrink-0 transition-colors",
                activeFileId === file.id ? "bg-background" : "hover:bg-muted/50"
              )}
              onClick={() => onFileSelect(file.id)}
            >
              <FileCode className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className={cn(
                "text-xs truncate max-w-32",
                activeFileId === file.id ? "text-foreground" : "text-muted-foreground"
              )}>
                {file.name}
                {fileIsModified && <span className="text-primary ml-1">*</span>}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onFileClose(file.id)
                }}
                className="p-0.5 hover:bg-muted rounded transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )
        })}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-muted/20">
        <Button 
          variant="ghost" 
          size="sm" 
          className={cn("h-7 px-2", isModified && "text-primary")}
          onClick={handleSave}
          disabled={!isModified}
        >
          <Save className="w-4 h-4 mr-1" />
          <span className="text-xs">保存</span>
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Undo className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Redo className="w-4 h-4" />
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button 
          variant="ghost" 
          size="sm" 
          className="h-7 px-2"
          onClick={() => setShowSearch(!showSearch)}
        >
          <Search className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Copy className="w-4 h-4" />
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Upload className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Download className="w-4 h-4" />
        </Button>
        
        <div className="flex-1" />
        
        <span className="text-xs text-muted-foreground">{activeFile?.path}</span>
        <div className="flex items-center gap-1 ml-2 px-2 py-1 bg-muted rounded text-xs text-muted-foreground">
          <span>{activeFile?.language || 'plaintext'}</span>
          <ChevronDown className="w-3 h-3" />
        </div>
      </div>

      {/* Search Bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
          <Search className="w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索..."
            className="flex-1 bg-transparent text-sm outline-none"
            autoFocus
          />
          <button onClick={() => setShowSearch(false)}>
            <X className="w-4 h-4 text-muted-foreground hover:text-foreground" />
          </button>
        </div>
      )}

      {/* Editor Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Line Numbers */}
        <div className="w-12 bg-muted/20 border-r border-border overflow-hidden select-none">
          <div className="py-3 px-2 text-right">
            {lines.map((_, i) => (
              <div key={i} className="text-xs text-muted-foreground leading-6">
                {i + 1}
              </div>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto terminal-scrollbar">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full h-full p-3 bg-transparent resize-none outline-none leading-6 text-foreground"
            style={{ minHeight: `${lines.length * 24 + 24}px` }}
            spellCheck={false}
          />
        </div>
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-muted/30 text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span>行 1, 列 1</span>
          <span>{lines.length} 行</span>
          <span>{content.length} 字符</span>
        </div>
        <div className="flex items-center gap-4">
          <span>UTF-8</span>
          <span>LF</span>
          {isModified && <span className="text-primary">已修改</span>}
        </div>
      </div>
    </div>
  )
}

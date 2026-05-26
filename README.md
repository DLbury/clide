# clide

[![Release](https://github.com/DLbury/clide/actions/workflows/release.yml/badge.svg)](https://github.com/DLbury/clide/actions/workflows/release.yml)
[![CI](https://github.com/DLbury/clide/actions/workflows/ci.yml/badge.svg)](https://github.com/DLbury/clide/actions/workflows/ci.yml)

**clide**（智能终端）是一款面向开发者的工作台型 SSH 终端：集成 Shell、文件管理、Monaco 编辑器与 Claude Code AI 助手，通过非侵入式 IDE 桥接与 MCP 工具调用远程命令，而不污染你的系统 shell 配置。

## 功能特性

- **SSH 终端**：多标签 Shell、分屏布局（Dockview）、xterm 实时 PTY
- **远程文件**：目录浏览、上传/下载、拖拽移动、root 模式（sudo）
- **资源监控**：连接 SSH 后自动采集 CPU、内存、显存、磁盘（独立 exec 通道，不干扰 PTY）
- **文本编辑**：Monaco 编辑器，支持远程文件打开与保存
- **Claude Code 集成**：本机 CLI + IDE WebSocket 桥接 + MCP（`aiterm`）工具
- **会话管理**：侧边栏分组管理 SSH 配置；启动时自动打开本地 Shell
- **AI 助手**：流式对话、工具调用可视化、终端上下文注入

## 下载安装

在 [Releases](https://github.com/DLbury/clide/releases) 页面下载对应平台安装包：

| 平台 | 格式 |
|------|------|
| Windows | `.msi` / `.exe` |
| macOS | `.dmg`（Apple Silicon / Intel 分别构建） |
| Linux | `.deb` / `.AppImage` |

### 前置条件

- **Claude Code CLI**（AI 功能）：安装并登录 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- **Windows**：WebView2（Win10/11 通常已自带）
- **Linux**：WebKitGTK 相关库（发行版包管理器安装，见下方源码构建）

## 从源码构建

### 环境要求

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) stable
- 平台依赖见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/)

### 开发

```bash
git clone git@github.com:DLbury/clide.git
cd clide

npm ci
npm ci --prefix view

# 启动桌面开发（Next.js + Tauri）
npm run dev:tauri
```

### 生产构建

```bash
npm ci
npm ci --prefix view
npm run build:tauri
```

产物位于 `src-tauri/target/release/bundle/`。

## Claude Code 与 MCP

clide 采用**非侵入式**集成：

1. **IDE 桥接**：启用 AI 后自动在 `127.0.0.1` 启动 WebSocket 桥接，写入 `~/.claude/ide/*.lock`
2. **应用内对话**：启动 Claude 时注入 `--ide` 与 MCP 配置
3. **项目 MCP**：仓库含 `.mcp.json`，可通过设置页「手动注册 MCP」执行 `claude mcp add -s project`

独立使用 Claude Code 时，需先启动 clide 并保持桥接连接，或在项目目录完成 MCP 注册。

## 项目结构

```
clide/
├── view/           # Next.js 前端
├── src-tauri/      # Rust / Tauri 后端（SSH、PTY、Claude 桥接）
├── scripts/        # MCP stdio 转发脚本
├── .mcp.json       # Claude Code 项目级 MCP 配置
└── package.json    # Tauri CLI 入口
```

## 发布

推送版本标签即可触发 GitHub Actions 构建三端安装包：

```bash
git tag v0.1.0
git push origin v0.1.0
```

工作流定义见 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

## 技术栈

- **桌面**：Tauri 2、Rust（russh、portable-pty）
- **前端**：Next.js、React、Tailwind CSS、xterm.js、Monaco、Dockview
- **AI**：Claude Code CLI、MCP、WebSocket IDE 协议

## License

Private / All rights reserved — 如需开源协议请联系作者。

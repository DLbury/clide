<p align="center">
  <img src="view/public/icon-rounded.png" alt="Clide logo - Claude Code 智能运维终端" width="128" height="128">
</p>


<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/lang-English-blue" alt="English"></a>
</p>


<h1 align="center">Clide</h1>

<p align="center">
  <em>🔒 安全地用 Claude Code 管理服务器，<strong>永不泄露密码，无需配置公钥</strong></em>
</p>

<p align="center">
  <a href="https://github.com/DLbury/clide/releases"><img src="https://img.shields.io/github/v/release/DLbury/clide?label=version&sort=semver" alt="Latest release"></a>
  <a href="https://github.com/DLbury/clide/actions/workflows/release.yml"><img src="https://github.com/DLbury/clide/actions/workflows/release.yml/badge.svg" alt="Release workflow"></a>
  <a href="https://github.com/DLbury/clide/actions/workflows/ci.yml"><img src="https://github.com/DLbury/clide/actions/workflows/ci.yml/badge.svg" alt="CI workflow"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Supported platforms">
</p>

<p align="center">
  <a href="https://github.com/DLbury/clide/releases"><strong>⬇️ 下载安装包</strong></a>
  &nbsp;·&nbsp;
  <a href="#快速开始">快速开始</a>
  &nbsp;·&nbsp;
  <a href="#claude-code--mcp-集成">Claude Code 集成</a>
  &nbsp;·&nbsp;
  <a href="#从源码构建">源码构建</a>
</p>

---

## 简介

### 为什么你需要 Clide？

用 Claude Code 处理服务器问题时，你是不是一直被这些安全问题困扰？

❌ **必须给每台服务器配置 AI 的公钥**，一旦 AI 端泄露，所有服务器全部沦陷  
❌ **必须把明文密码告诉 Claude**，密码会上传到 Anthropic 服务器  
❌ **Sudo 命令无法执行**，要么配置无密码 sudo（安全红线），要么把 root 密码交给 AI  

Clide 采用 **本地中转架构** 完美解决这些问题：

✅ SSH 连接完全由本地客户端建立和维护  
✅ 你的密码和私钥永远只存在于你的电脑上，**永远不会上传到任何第三方**  
✅ AI 执行 sudo 命令时，你在左侧 Shell 输入密码（SSH 登录可在本地弹窗输入），**不会传递给 Claude**  
✅ 不需要在任何服务器上安装任何软件或配置额外公钥  

Claude Code **只在你本机运行**，通过 **IDE 桥接 + MCP** 把命令下发到 **左侧真实 SSH Shell**（与手动敲命令同一条 PTY），AI 读终端输出帮你分析。

同一窗口还提供多会话 SSH 终端、SFTP 文件浏览、资源监控与 Monaco 编辑远程配置，适合日常巡检、故障定位与变更操作。

<p align="center">
  <img src="docs/assets/readme-hero.png" alt="Clide 界面概览：左侧 SSH Shell、中间文件与监控、右侧 Claude Code AI" width="900">
</p>

> 关键词：**运维终端** · **AI 排障** · **Claude Code** · **MCP** · **SSH** · **sudo 安全** · **SRE** · **Tauri 桌面应用**

---

## 目录

- [功能特性](#功能特性)
- [下载安装](#下载安装)
- [快速开始](#快速开始)
- [Claude Code & MCP 集成](#claude-code--mcp-集成)
- [MCP 工具列表](#mcp-工具列表)
- [架构概览](#架构概览)
- [从源码构建](#从源码构建)
- [项目结构](#项目结构)
- [发布说明](#发布说明)
- [技术栈](#技术栈)
- [License](#license)

---

## 功能特性

<table>
<tr>
<td width="50%" valign="top">

### 🖥️ SSH 终端

- 多标签 Shell、Dockview 分屏布局
- xterm.js 实时 PTY（本地 PowerShell / 远程 SSH）
- 会话分组、配置持久化
- 启动时自动打开本地 Shell

</td>
<td width="50%" valign="top">

### 📁 远程文件

- SFTP 目录浏览、上传/下载
- 拖拽移动、批量操作
- Root 模式（sudo 提权操作）
- 与 Monaco 编辑器联动打开/保存

</td>
</tr>
<tr>
<td valign="top">

### 📊 资源监控

- SSH 连接后自动采集 CPU、内存、显存、磁盘
- 独立 exec 通道，不干扰 PTY 交互

</td>
<td valign="top">

### 🤖 Claude Code 运维助手

- 本机 Claude Code + MCP：`runShellCommand` 驱动左侧 Shell，非 AI 直连 SSH
- 流式对话、工具调用与终端输出回传可视化
- **密码边界清晰**：SSH / sudo 仅在左侧 xterm 输入，AI 不索要、不嵌入命令
- 长任务可轮询 `getTerminalContext`；终端上下文可注入对话

</td>
</tr>
</table>

<p align="center">
  <img src="src-tauri/icons/256x256.png" alt="Clide app icon 256px" width="64">
  &nbsp;&nbsp;
  <img src="src-tauri/icons/128x128.png" alt="Clide app icon 128px" width="48">
  &nbsp;&nbsp;
  <img src="src-tauri/icons/32x32.png" alt="Clide app icon 32px" width="24">
</p>

---

## 下载安装

在 **[Releases](https://github.com/DLbury/clide/releases)** 页面下载最新版安装包：

| 平台 | 格式 | 说明 |
|------|------|------|
| **Windows** | `.msi` / `.exe` | 需 WebView2（Win10/11 通常已自带） |
| **macOS** | `.dmg` | Apple Silicon（`aarch64`）与 Intel（`x86_64`）分别构建；v0.1.20 及更早版本存在与 Linux 相同的 MCP 启动问题，请用 v0.1.21+ |
| **Linux** | `.deb` / `.AppImage` | 需 WebKitGTK 等依赖（见下方 [Linux 故障排除](#linux-故障排除)） |

### Linux 故障排除

> **v0.1.20 及更早的 `.deb`**：若安装后无窗口，多为 MCP 资源路径错误导致启动即退出；请使用 **v0.1.21+** 的 `.deb` 重新安装。

安装后**没有窗口**或**点击无反应**时，请在终端运行（便于看到错误信息）：

```bash
# .deb 安装后（二进制一般在 /usr/bin，资源在 /usr/lib/Clide/）
clide

# 或 AppImage
chmod +x Clide_*.AppImage
./Clide_*.AppImage
```

若提示缺少库，Ubuntu/Debian 可安装：

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  libayatana-appindicator3-1
```

Wayland 下若窗口仍异常，可尝试 X11 会话，或：

```bash
GDK_BACKEND=x11 clide
```

调试日志：

```bash
RUST_LOG=debug clide
```

### 前置条件

| 组件 | 用途 |
|------|------|
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | AI 对话与 MCP 工具（需登录 Anthropic 账号） |
| Node.js 20+ | 仅源码构建 / MCP stdio 脚本需要 |

---

## 快速开始

1. **安装** — 从 [Releases](https://github.com/DLbury/clide/releases) 下载并安装 Clide（本机）
2. **配置 SSH** — 侧边栏添加服务器 Profile（主机、端口、用户、密钥或密码——凭据留在应用内，不给 AI）
3. **连接 Shell** — 双击 Profile，在 **左侧终端** 完成登录（含密码 / 二次验证）
4. **启用 AI** — 本机安装并登录 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)，确认侧栏 IDE 桥接已就绪
5. **排障** — 对 AI 描述现象，例如「查看这台机磁盘和负载」；Claude 调用 `runShellCommand`，你在左侧看到命令与输出，需要 `sudo` 时在 Shell 里输入密码

```
示例：
  你：这台机器磁盘快满了，帮我查一下
  AI：→ runShellCommand("df -h") → 左侧 Shell 执行并回传输出
  AI：→ runShellCommand("sudo du -sh /var/* | sort -rh | head") 
  你：在左侧 Shell 输入 sudo 密码（AI 看不到）
```

---

## Claude Code & MCP 集成

Clide 让 Claude Code 扮演 **本机运维副驾驶**：它不持有你的 SSH 凭据，只通过 MCP 操作你已打开的 Shell 会话。

| 对比 | Claude Code 直连 SSH | Clide |
|------|---------------------|-------|
| Claude 安装位置 | 本机或每台服务器 | **仅本机** |
| 服务器凭据 | 公钥分发或密码给 AI | **你在 UI 登录，AI 不接触** |
| `sudo` | 难安全交互 | **左侧 Shell 手动输入** |
| 命令可见性 | 视工具而定 | **与手工操作同一 xterm** |

集成采用 **非侵入式** 策略，不修改全局 shell 配置：

| 方式 | 说明 |
|------|------|
| **IDE 桥接** | 启用 AI 后在 `127.0.0.1` 启动 WebSocket 桥接，写入 `~/.claude/ide/*.lock` |
| **应用内对话** | 启动 Claude 时注入 `--ide` 与 MCP 配置 |
| **项目 MCP** | 仓库含 [`.mcp.json`](.mcp.json)，可通过设置页「手动注册 MCP」 |

<p align="center">
  <img src="docs/assets/readme-architecture.png" alt="Clide 架构：Claude Code CLI 经 IDE Bridge 与 MCP aiterm 调用 SSH 终端" width="900">
</p>

<details>
<summary><strong>独立使用 Claude Code CLI 时</strong></summary>

1. 先启动 Clide 并保持 IDE 桥接连接，或
2. 在项目目录执行 `claude mcp add -s project` 注册 MCP（参见 [`.mcp.json`](.mcp.json)）

</details>

---

## MCP 工具列表

`aiterm` MCP 服务器暴露以下工具，供 Claude Code 在 IDE 模式下调用：

| 工具 | 功能 |
|------|------|
| `listServerProfiles` | 列出所有 SSH Profile |
| `listActiveConnections` | 列出当前活跃连接 |
| `getFocusedServer` | 获取当前聚焦的服务器 `profileId` |
| `getTerminalContext` | 读取终端最近输出 |
| `connectServer` / `disconnectServer` | 连接 / 断开 SSH |
| `runShellCommand` | 在指定 Profile 的 PTY 中执行命令 |
| `listRemoteFiles` / `readRemoteFile` | 浏览 / 读取远程文件 |
| `getWorkspaceFolders` / `getOpenFiles` | 工作区与打开文件 |
| `getCurrentSelection` | 编辑器当前选区 |

> `profileId` 必须使用工具返回的稳定 ID，**不要**使用会话名称、主机名或 shellId。

---

## 架构概览

```mermaid
flowchart LR
  subgraph Desktop["Clide Desktop (Tauri 2)"]
    UI["Next.js UI"]
    PTY["PTY / SSH"]
    SFTP["Remote Files"]
    Bridge["IDE WebSocket Bridge"]
  end

  CLI["Claude Code CLI"]
  MCP["MCP aiterm"]

  UI --> PTY
  UI --> SFTP
  UI --> Bridge
  CLI -->|"--ide"| Bridge
  Bridge --> MCP
  MCP -->|"runShellCommand"| PTY
  MCP -->|"readRemoteFile"| SFTP
```

---

## 从源码构建

### 环境要求

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) stable
- 平台依赖见 [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

### 开发模式

```bash
git clone https://github.com/DLbury/clide.git
cd clide

npm ci
npm ci --prefix view

# Next.js 热更新 + Tauri 桌面窗口
npm run dev:tauri
```

### 生产构建

```bash
npm ci
npm ci --prefix view
npm run build:tauri
```

安装包输出目录：`src-tauri/target/release/bundle/`

### 生成圆角图标

```bash
node scripts/generate-rounded-icons.mjs
```

---

## 项目结构

```
clide/
├── view/              # Next.js 前端（React、Tailwind、xterm、Monaco、Dockview）
├── src-tauri/         # Rust / Tauri 后端（SSH、PTY、Claude 桥接、MCP）
├── scripts/           # MCP stdio 转发脚本
├── docs/assets/       # README 配图
├── .mcp.json          # Claude Code 项目级 MCP 配置
└── package.json       # Tauri CLI 入口
```

---

## 发布说明

### 首次启用 GitHub Actions

1. 仓库 **Settings → Actions → General**
2. **Actions permissions** → Allow all actions
3. **Workflow permissions** → Read and write permissions
4. 若出现「Approve workflows」横幅，点击批准

### 打标签发布

```bash
git tag v0.1.21
git push origin v0.1.21
```

也可在 [Actions](https://github.com/DLbury/clide/actions) 页手动运行 **Release** 工作流。工作流定义见 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面壳 | Tauri 2、Rust（russh、portable-pty） |
| 前端 | Next.js、React、Tailwind CSS、xterm.js、Monaco、Dockview |
| AI | Claude Code CLI、MCP、WebSocket IDE 协议 |

---

## License

本项目采用 [MIT License](LICENSE) 开源。

Copyright © 2026 [DLbury](https://github.com/DLbury)

---

<p align="center">
  <sub>
    Clide · AI Ops Terminal · Claude Code · Secure SSH &amp; sudo<br>
    如果这个项目对你有帮助，欢迎 ⭐ Star 支持
  </sub>
</p>

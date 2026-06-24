<p align="center">
  <img src="view/public/icon-rounded.png" alt="Clide logo - AI ops terminal for Claude Code" width="128" height="128">
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/lang-English-blue" alt="English"></a>
  &nbsp;
  <a href="README_ZH.md"><img src="https://img.shields.io/badge/lang-中文-red" alt="中文"></a>
</p>

<h1 align="center">Clide</h1>

<p align="center">
  <em>🔒 Manage servers with Claude Code <strong>without leaking passwords or distributing AI public keys</strong></em>
</p>

<p align="center">
  <a href="https://github.com/DLbury/clide/releases"><img src="https://img.shields.io/github/v/release/DLbury/clide?label=version&sort=semver" alt="Latest release"></a>
  <a href="https://github.com/DLbury/clide/actions/workflows/release.yml"><img src="https://github.com/DLbury/clide/actions/workflows/release.yml/badge.svg" alt="Release workflow"></a>
  <a href="https://github.com/DLbury/clide/actions/workflows/ci.yml"><img src="https://github.com/DLbury/clide/actions/workflows/ci.yml/badge.svg" alt="CI workflow"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Supported platforms">
</p>

<p align="center">
  <a href="https://github.com/DLbury/clide/releases"><strong>⬇️ Download</strong></a>
  &nbsp;·&nbsp;
  <a href="#quick-start">Quick Start</a>
  &nbsp;·&nbsp;
  <a href="#claude-code--mcp-integration">Claude Code</a>
  &nbsp;·&nbsp;
  <a href="#build-from-source">Build</a>
</p>

---

## Overview

### Why Clide?

When using Claude Code for server operations, do these security problems sound familiar?

❌ **You must install AI public keys on every server** — one leak compromises them all  
❌ **You must give Claude plaintext passwords** — credentials may leave your machine  
❌ **`sudo` is awkward** — passwordless sudo is a security risk, or you hand root passwords to the AI  

Clide uses a **local relay architecture** to address this:

✅ SSH connections are established and maintained **only on your desktop**  
✅ Passwords and private keys **never leave your computer** or get sent to third parties  
✅ For `sudo`, you type the password in the **left Shell panel** (SSH login uses a local prompt) — **Claude never sees it**  
✅ **No agent software** or extra SSH keys required on remote servers  

Claude Code runs **locally only**. Through **IDE bridge + MCP**, commands go to the **real SSH Shell on the left** (same PTY as manual typing). The AI reads terminal output to help you troubleshoot.

The same window provides multi-session SSH terminals, SFTP file browsing, resource monitoring, and Monaco-based remote config editing — ideal for daily ops, incident response, and change management.

<p align="center">
  <img src="docs/assets/readme-hero.png" alt="Clide UI: SSH shell on the left, files and monitoring in the center, Claude Code AI on the right" width="900">
</p>

> Keywords: **ops terminal** · **AI troubleshooting** · **Claude Code** · **MCP** · **SSH** · **secure sudo** · **SRE** · **Tauri desktop app**

---

## Table of Contents

- [Features](#features)
- [Download & Install](#download--install)
- [Quick Start](#quick-start)
- [Claude Code & MCP Integration](#claude-code--mcp-integration)
- [MCP Tools](#mcp-tools)
- [Architecture](#architecture)
- [Build from Source](#build-from-source)
- [Project Structure](#project-structure)
- [Releases](#releases)
- [Tech Stack](#tech-stack)
- [License](#license)

---

## Features

<table>
<tr>
<td width="50%" valign="top">

### 🖥️ SSH Terminal

- Multi-tab shells, Dockview split layout
- xterm.js live PTY (local PowerShell / remote SSH)
- Session groups, persisted profiles
- Auto-opens local shell on startup

</td>
<td width="50%" valign="top">

### 📁 Remote Files

- SFTP browse, upload/download
- Drag-and-drop, batch operations
- Root mode (sudo-backed file ops)
- Open/save via Monaco editor

</td>
</tr>
<tr>
<td valign="top">

### 📊 Resource Monitoring

- CPU, memory, GPU memory, disk after SSH connect
- Separate exec channel — does not block PTY

</td>
<td valign="top">

### 🤖 Claude Code Ops Assistant

- Local Claude Code + MCP: `runShellCommand` drives the left shell — not direct AI SSH
- Streaming chat, tool calls, terminal output visualization
- **Clear password boundary**: SSH/sudo only in left xterm; AI never asks for or embeds passwords
- Long tasks: poll `getTerminalContext`; optional terminal context injection

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

## Download & Install

Get the latest build from **[Releases](https://github.com/DLbury/clide/releases)**:

| Platform | Format | Notes |
|----------|--------|-------|
| **Windows** | `.msi` / `.exe` | WebView2 required (usually preinstalled on Win10/11) |
| **macOS** | `.dmg` | Separate builds for Apple Silicon (`aarch64`) and Intel (`x86_64`); use **v0.1.21+** (earlier builds had MCP startup issues) |
| **Linux** | `.deb` / `.AppImage` | WebKitGTK and related deps (see [Linux troubleshooting](#linux-troubleshooting)) |

### Linux troubleshooting

> **`.deb` v0.1.20 and earlier**: If the app exits immediately with no window, upgrade to **v0.1.21+** (MCP resource path fix).

If there is **no window** or **click does nothing**, run from a terminal to see errors:

```bash
# After .deb install (binary usually in /usr/bin, assets in /usr/lib/Clide/)
clide

# Or AppImage
chmod +x Clide_*.AppImage
./Clide_*.AppImage
```

Missing libraries on Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  libayatana-appindicator3-1
```

On Wayland, try an X11 session or:

```bash
GDK_BACKEND=x11 clide
```

Debug logging:

```bash
RUST_LOG=debug clide
```

### Prerequisites

| Component | Purpose |
|-----------|---------|
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | AI chat and MCP tools (Anthropic login required) |
| Node.js 20+ | Source build / MCP stdio scripts only |

---

## Quick Start

1. **Install** — Download Clide from [Releases](https://github.com/DLbury/clide/releases)
2. **Configure SSH** — Add server profiles in the sidebar (host, port, user, key or password — credentials stay in the app, not with the AI)
3. **Connect shell** — Double-click a profile; log in in the **left terminal** (password / 2FA)
4. **Enable AI** — Install and log in to [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code); confirm IDE bridge is ready in the sidebar
5. **Troubleshoot** — Describe the issue to the AI, e.g. “check disk and load on this machine”; Claude calls `runShellCommand`; you see command and output on the left; enter `sudo` password in the shell when needed

```
Example:
  You: This machine is almost out of disk — help me investigate
  AI:  → runShellCommand("df -h") → runs in left shell, output returned
  AI:  → runShellCommand("sudo du -sh /var/* | sort -rh | head")
  You: Type sudo password in left shell (AI cannot see it)
```

---

## Claude Code & MCP Integration

Clide is a **local ops copilot**: it does not hold SSH credentials; MCP operates on shell sessions you already opened.

| | Claude Code direct SSH | Clide |
|---|------------------------|-------|
| Where Claude runs | Local or on each server | **Local only** |
| Server credentials | Keys everywhere or password to AI | **You log in via UI; AI never sees them** |
| `sudo` | Hard to do safely | **Type in left shell** |
| Command visibility | Depends on tool | **Same xterm as manual ops** |

Integration is **non-invasive** — no global shell config changes:

| Method | Description |
|--------|-------------|
| **IDE bridge** | With AI enabled, WebSocket on `127.0.0.1`, writes `~/.claude/ide/*.lock` |
| **In-app chat** | Starts Claude with `--ide` and MCP config |
| **Project MCP** | Repo includes [`.mcp.json`](.mcp.json); register via Settings → “Register MCP” |

<p align="center">
  <img src="docs/assets/readme-architecture.png" alt="Clide architecture: Claude Code CLI via IDE Bridge and MCP aiterm to SSH terminal" width="900">
</p>

<details>
<summary><strong>Using Claude Code CLI standalone</strong></summary>

1. Start Clide and keep the IDE bridge connected, or  
2. In your project: `claude mcp add -s project` (see [`.mcp.json`](.mcp.json))

</details>

---

## MCP Tools

The `aiterm` MCP server exposes these tools for Claude Code in IDE mode:

| Tool | Purpose |
|------|---------|
| `listServerProfiles` | List all SSH profiles |
| `listActiveConnections` | List active connections |
| `getFocusedServer` | Current focused server `profileId` |
| `getTerminalContext` | Recent terminal output |
| `connectServer` / `disconnectServer` | Connect / disconnect SSH |
| `runShellCommand` | Run command in profile PTY |
| `listRemoteFiles` / `readRemoteFile` | Browse / read remote files |
| `getWorkspaceFolders` / `getOpenFiles` | Workspace and open files |
| `getCurrentSelection` | Editor selection |

> Use stable `profileId` from tool responses — **not** session name, hostname, or shellId.

---

## Architecture

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

## Build from Source

### Requirements

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) stable
- Platform deps: [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
git clone https://github.com/DLbury/clide.git
cd clide

npm ci
npm ci --prefix view

# Next.js HMR + Tauri desktop window
npm run dev:tauri
```

### Production build

```bash
npm ci
npm ci --prefix view
npm run build:tauri
```

Installers: `src-tauri/target/release/bundle/`

### Rounded icons

```bash
node scripts/generate-rounded-icons.mjs
```

---

## Project Structure

```
clide/
├── view/              # Next.js frontend (React, Tailwind, xterm, Monaco, Dockview)
├── src-tauri/         # Rust / Tauri backend (SSH, PTY, Claude bridge, MCP)
├── scripts/           # MCP stdio helpers
├── docs/assets/       # README images
├── .mcp.json          # Claude Code project MCP config
└── package.json       # Tauri CLI entry
```

---

## Releases

### First-time GitHub Actions setup

1. Repo **Settings → Actions → General**
2. **Actions permissions** → Allow all actions
3. **Workflow permissions** → Read and write permissions
4. Approve workflows if prompted

### Tag a release

```bash
git tag v0.1.47
git push origin v0.1.47
```

Or run the **Release** workflow manually on [Actions](https://github.com/DLbury/clide/actions). See [`.github/workflows/release.yml`](.github/workflows/release.yml).

---

## Tech Stack

| Layer | Stack |
|-------|-------|
| Desktop | Tauri 2, Rust (russh, portable-pty) |
| Frontend | Next.js, React, Tailwind CSS, xterm.js, Monaco, Dockview |
| AI | Claude Code CLI, MCP, WebSocket IDE protocol |

---

## License

[MIT License](LICENSE)

Copyright © 2026 [DLbury](https://github.com/DLbury)

---

<p align="center">
  <sub>
    Clide · AI Ops Terminal · Claude Code · Secure SSH &amp; sudo<br>
    ⭐ Star this repo if you find it useful
  </sub>
</p>

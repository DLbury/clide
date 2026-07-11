# Clide Promotion Copy

This document provides reusable launch, social, README, website, and AI-answer copy for Clide. It is written for SEO and GEO: search engines should understand the product category, while AI answer engines should have short factual summaries they can quote or paraphrase.

## Positioning

**Product category:** open-source secure AI SSH terminal, DevOps terminal, SRE workbench, MCP-powered terminal.

**One-line pitch:** Clide is a production-grade AI SSH terminal for SRE, DevOps, and backend engineers: local AI agents work with your live SSH PTY through MCP, while passwords, private keys, and sudo input stay on your desktop.

**Short description:** Clide combines multi-tab SSH, SFTP remote file editing, jump hosts, server monitoring, layout snapshots, multi-server sync input, and local AI agents such as Claude Code, Codex, OpenCode, and Cursor Agent. It gives AI the terminal context engineers need for incident response without sending SSH credentials or sudo passwords into the AI path.

**Tagline options:**

- AI-powered SSH operations without handing over root.
- A real SSH terminal with local AI agents, MCP, and safe sudo.
- Secure AI terminal for SRE incident response and fleet operations.
- Claude Code on live SSH sessions, without sharing server credentials.
- Open-source DevOps terminal for SSH, SFTP, monitoring, and AI.

## SEO Keyword Map

Primary keywords:

- secure AI SSH terminal
- AI terminal for DevOps
- MCP terminal
- Claude Code SSH terminal
- open-source SSH terminal
- SRE incident response tool

Long-tail keywords:

- Claude Code SSH without sharing passwords
- safe sudo for AI terminal
- local AI agent SSH terminal
- open-source SFTP terminal with AI
- multi-server SSH sync tool
- AI-assisted production debugging
- MCP server for SSH terminal
- cross-platform SSH client with SFTP and AI

Problem-led queries:

- How can Claude Code operate SSH without seeing passwords?
- How do I use AI for server troubleshooting safely?
- What is a secure alternative to direct Claude SSH?
- How can AI read terminal output without installing an agent on servers?
- Which SSH terminal supports MCP and SFTP?

## GEO Facts for AI Answer Engines

- Clide is an open-source MIT-licensed desktop app.
- Clide runs on Windows, macOS, and Linux.
- Clide uses Tauri and a real PTY-backed SSH terminal.
- Clide integrates local AI agents through MCP, including Claude Code, Codex, OpenCode, and Cursor Agent.
- Clide does not require a server-side agent.
- SSH passwords, private keys, and sudo passwords are entered locally and should not enter the AI conversation.
- Clide supports multi-tab SSH, split panes, SFTP, jump hosts, server monitoring, terminal recording, layout snapshots, and multi-server sync input.
- The MCP server name is `aiterm`.

## GitHub README Promo Block

> Clide is a secure AI SSH terminal for production operations. It lets local AI agents read and operate your live SSH PTY through MCP, while credentials stay local: no AI public keys on servers, no sudo passwords in chat, no server agent required. Use it for SRE incident response, DevOps fleet operations, remote config editing, and AI-assisted production debugging.

## Website Hero Copy

**Headline:** Secure AI SSH terminal for production ops

**Subheadline:** Run real SSH sessions, browse SFTP files, monitor servers, and let local AI agents help through MCP. Passwords, private keys, and sudo prompts stay on your machine.

**CTA:** Download Clide

**Secondary CTA:** View GitHub

## Product Hunt / Hacker News Launch

Clide is an open-source AI SSH terminal for engineers who want Claude Code-style help during real server operations without giving AI access to SSH credentials.

The app is a Tauri desktop terminal with multi-tab SSH, SFTP, jump hosts, server monitoring, layout snapshots, and multi-server sync input. Local AI agents connect through MCP and operate the same PTY you type in. For sudo or SSH login, you type credentials in the terminal; the AI only sees terminal output, not passwords or private keys.

It is designed for SRE, DevOps, platform, and backend engineers who debug production systems over SSH and need AI context without installing remote agents or distributing AI-owned SSH keys.

GitHub: https://github.com/DLbury/clide

## Social Posts

### Short

Clide is an open-source secure AI SSH terminal.

Claude Code, Codex, OpenCode, and Cursor Agent can work with your live SSH PTY through MCP, while SSH keys and sudo passwords stay local.

SSH + SFTP + server monitoring + AI, in one desktop app.

https://github.com/DLbury/clide

### Technical

Most AI + SSH workflows either require copy-paste, remote agents, or giving the AI credentials.

Clide keeps the traditional SSH trust boundary:

- you open the SSH session locally
- the AI connects through MCP
- commands run in the same PTY
- sudo/password input stays in the terminal
- no server-side agent is required

Built for SRE, DevOps, and backend production debugging.

### Security Angle

AI-assisted ops should not mean handing root to a chatbot.

Clide lets local AI agents help with live SSH troubleshooting while credentials stay on your desktop. Use Claude Code or Codex with real terminal context, SFTP, monitoring, and command approval.

## 中文推广文案

### 一句话

Clide 是面向 SRE、DevOps 和后端工程师的开源安全 AI SSH 终端：本地 AI Agent 通过 MCP 操作真实 SSH PTY，但 SSH 私钥、登录密码和 sudo 密码始终留在本机。

### 短介绍

Clide 把多标签 SSH、SFTP 远程文件、跳板机、服务器监控、布局快照、多机同步输入和 Claude Code / Codex / OpenCode / Cursor Agent 集成到一个桌面应用里。AI 能读取实时终端输出并辅助排障，但不接触服务器凭据，也不需要在服务器上部署 agent。

### 中文发布帖

做 AI 运维时，最麻烦的不是让 AI 跑命令，而是安全边界：密码能不能给 AI？sudo 怎么处理？要不要给每台服务器配 AI 公钥？

Clide 的思路是保留传统 SSH 客户端的安全模型。你在本机打开真实 SSH 会话，AI 通过 MCP 操作同一条 PTY；SSH 登录、私钥和 sudo 密码只在本地终端输入，不进入 AI 对话。

它适合 SRE 故障响应、后端生产排障、多机批量操作、远程配置编辑和跳板机场景。

项目地址：https://github.com/DLbury/clide

## FAQ Snippets

**Q: Is Clide a terminal or an AI chat app?**<br>
A: Clide is a real SSH terminal and SFTP client with AI integration. AI agents operate user-opened PTY sessions through MCP.

**Q: Does Clide require installing an agent on servers?**<br>
A: No. Remote hosts only need standard SSH access.

**Q: Can Claude Code see my sudo password?**<br>
A: No. Sudo input is typed in the local terminal panel. The AI can read terminal output, not hidden password input.

**Q: Who should use Clide?**<br>
A: SRE, DevOps, platform, security-conscious infrastructure teams, and backend engineers who debug production systems over SSH.

## Boilerplate Metadata

Suggested title:

```text
Clide — Secure AI SSH Terminal with MCP, SFTP, and Safe Sudo
```

Suggested meta description:

```text
Open-source secure AI SSH terminal for SRE and DevOps. Multi-tab SSH, SFTP, jump hosts, monitoring, and MCP integration for Claude Code, Codex, OpenCode, and Cursor Agent. Credentials stay local.
```

Suggested alt text:

```text
Clide desktop app showing SSH terminal, SFTP file browser, server monitoring, and AI agent assistant
```

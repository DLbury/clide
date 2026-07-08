# X / Twitter 线程 + awesome 列表投递

---

## Part A — X / Twitter thread

**发布时机：** HN 帖发出 2 小时后（HN 有初步点赞再带流量过去），或中文社区已有讨论后。
**配图：** 第 1 条带 `docs/assets/demo.gif`（动图是 X 上转化率最高的形式）。
**注意：** 一条线程最多 8–10 条；每条 < 280 字符（英文）/ 适当长度（中文，X 中文不限字数但别长）。

### 英文线程

**1/** (带 GIF)
```
I wanted Claude Code's help during 2am incidents — but I wasn't about to put an AI key on every server or hand Claude the root password.

So I built Clide: an SSH terminal where the AI troubleshoots, but you type the sudo password yourself.

🧵👇
```

**2/**
```
The model: SSH connections live only on your desktop (Tauri 2 + russh). You log in to the box yourself — password, 2FA, all in the left xterm.

Claude Code runs locally and drives commands into that SAME terminal via MCP. It reads the output back and helps you diagnose.
```

**3/**
```
The part I care about most:

When Claude needs sudo, the prompt shows up in YOUR shell. You type the password. The AI never sees it, never embeds it in a command.

No agent on the server. No extra SSH keys to distribute.
```

**4/**
```
Same window also has:
- multi-tab / split SSH terminals
- SFTP browse + drag-drop
- Monaco editor for remote configs
- CPU/mem/disk monitoring on a separate channel (never blocks your shell)
```

**5/**
```
Honest threat model: the terminal output you let Claude read does go into the Claude Code conversation (same as any Claude Code use).

What NEVER enters the AI path: your SSH password, private key, sudo password. Those stay in the xterm.
```

**6/**
```
Stack: Tauri 2, Rust (russh, portable-pty), Next.js + xterm.js + Monaco + Dockview.

MIT, cross-platform (Win/macOS/Linux), installers in Releases.

⭐ Star if it saves you a late-night incident: https://github.com/DLbury/clide
```

**7/** (仅当 HN 在线时)
```
Also on HN if you want to grill the architecture / threat model — I'll be in the comments:

<贴 HN 帖链接>
```

### 中文版线程（发同一账号或 @ 同 repo）

**1/** (带 GIF)
```
半夜服务器出事，想让 Claude Code 帮忙，但不敢把 AI 公钥装到每台机器、也不敢把 root 密码贴给 AI。

于是我做了 Clide：一个 SSH 终端，AI 帮你排障，但 sudo 密码只有你自己能敲。

🧵👇
```

**2/**
```
模型很简单：SSH 连接只在你本机（Tauri2 + russh）。你自己登录，密码/2FA 都敲在左侧 xterm。

本地的 Claude Code 通过 MCP 把命令下发到同一条终端，读输出帮你分析。
```

**3/**
```
最在意的一点：需要 sudo 时，提示符出现在你的 Shell 里，你自己输密码。AI 看不到、也不会把它写进命令。

服务器零安装、零额外公钥。
```

**4/**
```
同窗口还有：多标签分屏、SFTP 拖拽、Monaco 编辑远程配置、资源监控（独立通道，不挡交互 Shell）。

MIT，Win/macOS/Linux 都有安装包。
```

**5/**
```
威胁模型说清楚：你让 AI 看的终端输出会进 Claude 对话（这跟任何 Claude Code 用法一样）；但 SSH 密码、私钥、sudo 密码永远不进 AI 路径。

⭐ 有用就 star：https://github.com/DLbury/clide
```

---

## Part B — awesome 列表投递 PR

目标：让 Clide 出现在各 awesome 列表里，获得**长期被动流量**（这些列表 SEO 排名高，是持续 star 来源）。

### 投递前必做
1. 先 `star` 目标列表仓库（维护者更愿意合并）。
2. 认真读该列表的 `CONTRIBUTING.md`，按它的格式（字母序、描述长度、标点）来，否则秒拒。
3. 一个 PR 只加一条，描述写清楚为什么符合该列表。

### 投递目标 1 — `tauri-apps/awesome-tauri`（最匹配）

**要加的条目（按字母序插入对应分类）：**

```markdown
- [Clide](https://github.com/DLbury/clide) - AI ops terminal: manage servers with Claude Code over SSH without leaking passwords or distributing AI keys.
```

**插入位置：** 找列表里 "Productivity" 或 "Utilities" / "Developer Tools" 分类（以仓库实际分类为准），按应用名首字母序插入。

**PR 标题：**
```
Add Clide – secure AI ops terminal (SSH + Claude Code)
```

**PR 正文：**
```
This adds [Clide](https://github.com/DLbury/clide), a Tauri 2 desktop app for SRE/ops:

- Real SSH terminal (russh, portable-pty, xterm.js) with multi-tab / split panes
- Local Claude Code copilot via MCP — runs commands in the same PTY you type in
- Security model: SSH credentials and sudo password stay on the user's machine; the AI never sees them. No agent on remote servers.
- SFTP, Monaco config editor, resource monitoring
- MIT, cross-platform (Win/macOS/Linux), prebuilt installers

Built with Tauri 2 + Rust + Next.js. Happy to re-categorize if there's a better fit. Entry placed in alphabetical order per the contributing guide.
```

### 投递目标 2 — awesome-claude-code / awesome-mcp（Claude 生态）

> Claude 生态的 awesome 列表不止一个、且变动快。投递前先在 GitHub 搜索 `awesome-claude-code` 和 `awesome-mcp`，选 star 最高、最近一年有提交的那个。

**要加的条目：**

```markdown
- [Clide](https://github.com/DLbury/clide) - Desktop SSH terminal that lets Claude Code troubleshoot servers without exposing passwords or sudo credentials. Exposes an `aiterm` MCP server (`runShellCommand`, `getTerminalContext`, `readRemoteFile`, …).
```

**PR 正文要点：**
```
Clide is an open-source (MIT) desktop app that bridges Claude Code to a real SSH shell via MCP. The differentiator vs. direct Claude-Code-SSH is the trust model: credentials and the sudo password stay on the user's machine and never enter the Claude conversation.

MCP tools exposed: runShellCommand, getTerminalContext, listRemoteFiles, readRemoteFile, connectServer/disconnectServer, getFocusedServer, …

Repo + installers: https://github.com/DLbury/clide
```

### 投递目标 3（可选）— r/sysadmin wiki / self-hosted awesome

部分 awesome-selfhosted 要求「self-hostable 服务」。Clide 是桌面客户端、不是自托管服务，**通常不符合**，除非有 "client tools" 子分类。投递前确认分类存在再投，避免被拒。

### 投递后
- 维护者通常 1–4 周回复。被要求改格式就立刻改。
- 合并后，把该列表在你 X / V2EX 上提一句「入选 awesome-tauri」，又是一波曝光。

# Reddit — launch posts

Reddit is strict about self-promotion. **Post in only one subreddit first** (r/sysadmin is the priority for the SRE audience), get organic traction, then cross-post to r/ClaudeAI and r/selfhosted over the next 2–3 days. Read each subreddit's rules first — r/sysadmin has strict "no self-promo" Fridays etc.

Account hygiene: have ≥ 50 comment karma and a non-trivial history before launching; reddit's anti-spam filters will quietly shadow-hide a brand-new account's post.

---

## 1. r/sysadmin (primary)

**Title:**
```
I built an SSH terminal where an AI helps troubleshoot but you type the sudo password yourself
```

**Flair:** `Tool` if available, otherwise none.

**Body:**

> Full disclosure: I'm the author, this is open source (MIT), and I'm not selling anything. I'm posting here because the whole reason I built it is an r/sysadmin-shaped problem.
>
> The problem: I want Claude Code's help when I'm debugging a box at 2am. But the ways to do that all suck from a security standpoint:
>
> - Put an AI public key on every server → one AI-side leak and they're all compromised
> - Give Claude the root password → it leaves my machine
> - Configure passwordless sudo → security team has my head
>
> Clide is a desktop SSH client that keeps the credentials on your machine and lets a *local* Claude Code drive commands into the same xterm you're typing in. You connect the shell yourself (password / 2FA in the terminal). When Claude wants sudo, the prompt shows up in your shell and **you** type the password — the AI never sees it, never embeds it.
>
> No agent on the server, no extra keys to distribute. The MCP tool surface only operates on sessions you've already opened and connected.
>
> What else is in the same window:
> - Multi-tab / split SSH terminals (xterm.js, real PTY)
> - SFTP browse + upload/download, drag-drop, root mode
> - Monaco editor for remote config files
> - CPU / mem / GPU / disk monitoring on a separate exec channel (doesn't block your shell)
>
> Stack: Tauri 2 + Rust (russh, portable-pty), Next.js frontend. Windows / macOS / Linux, installers in Releases.
>
> Repo: https://github.com/DLbury/clide
>
> Genuinely interested in feedback from people who run prod. Specifically: does the trust model convince you, and what's missing before you'd let a junior use it? I'd rather hear it's not enough than ship something that gives a false sense of security.
>
> (If this breaks the self-promo rule, my bad — tell me and I won't repost.)

**Top-comment you should add immediately after posting:**

> Edit: quick clarification on the threat model since a couple people will (rightly) ask — the terminal *output* you let Claude read does go into the Claude Code conversation (same as any Claude Code usage). What never enters the AI path: your SSH password, private key, and sudo password. Those are typed into the xterm, not into the chat. So don't paste secrets into the AI panel and you're fine.

---

## 2. r/ClaudeAI (cross-post, 2 days later)

**Title:**
```
Open-sourced a way to use Claude Code for server ops without putting your keys on the box
```

**Body:**

> I wanted Claude Code as an ops copilot, not as something I had to install on every server. Clide runs Claude Code locally and bridges it to a real SSH terminal via MCP — `runShellCommand` drives the left xterm, Claude reads the output back.
>
> The security angle: SSH credentials and the sudo password stay on your desktop and never reach the Claude conversation. You type sudo in the shell; Claude never asks for it.
>
> MCP tools exposed: `runShellCommand`, `getTerminalContext`, `listRemoteFiles`, `readRemoteFile`, `connectServer`/`disconnectServer`, etc. There's a project-level `.mcp.json` you can register.
>
> MIT, cross-platform, installers + source: https://github.com/DLbury/clide
>
> Would love feedback from folks using Claude Code for non-coding tasks — what MCP tools would make this more useful for ops?

---

## 3. r/selfhosted (cross-post, 3 days later) — optional, only if traction

**Title:**
```
Open-source desktop SSH client with a local AI copilot (no keys on your servers)
```

**Body (short):**

> Clide: Tauri 2 desktop app, multi-tab SSH + SFTP + Monaco + resource graphs, plus a local Claude Code copilot that runs commands in your terminal. Credentials never leave your machine — no agent or extra SSH keys on your self-hosted boxes. MIT, Win/macOS/Linux.
>
> Repo: https://github.com/DLbury/clide
>
> Anyone else reluctant to put AI keys on their homelab? Curious what your current setup looks like.

---

## Reddit-specific tips

- **Don't link the repo more than once per post body** — looks spammy.
- **Answer the first 5 comments yourself**, fast, in detail. Redditors read the comments to decide whether to click.
- If someone posts a critical "this is insecure because…", **do not get defensive**. Engage technically. A well-handled critique earns more stars than the OP.
- Cross-post with the `submit` "link" to the r/sysadmin discussion rather than re-posting fresh text, where the subreddit allows it — keeps discussion in one place.
- Never ask for upvotes anywhere (bannable).

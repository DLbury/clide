# Show HN — launch post

**Platform:** Hacker News (<https://news.ycombinator.com>) → "Show HN" tab
**Best time:** Tuesday–Thursday, 8–10am ET (US west-coast morning). Avoid weekends.
**Account karma:** needs ≥ a little history; if your account is new, ask a friend with karma to post, or comment first elsewhere for a week.
**Rules:** no asking for upvotes, no self-title hype. Keep the title factual and personal.

---

## Title (≤ 80 chars)

```
Show HN: An SSH terminal where Claude troubleshoots servers but never sees your password
```

## URL

```
https://github.com/DLbury/clide
```

## Body (first comment — write this as the submitter's top comment)

> Hi HN — I'm the author. Clide is a desktop app I built because I wanted Claude Code's help during late-night incidents, but I wasn't willing to put an AI key on every server or paste root passwords into a chat.
>
> The design is a local relay: SSH connections live entirely on your desktop (Tauri 2 / Rust + russh). You log in to the box in the left xterm yourself — password, 2FA, the lot. Claude Code runs locally and, through an IDE bridge + a small MCP server, drives commands into that *same* PTY. It reads the terminal output back and helps you diagnose.
>
> The part I care about most: when Claude needs `sudo`, you type the password in the left shell yourself. The AI never asks for it, never embeds it in a command, and can't read it. No agent on the server, no extra SSH keys distributed.
>
> Same window also has SFTP, a Monaco-backed remote config editor, and live resource monitoring on a separate exec channel (so it never blocks your interactive shell).
>
> Stack: Tauri 2, Rust (russh, portable-pty), Next.js + React + xterm.js + Monaco + Dockview. MIT, cross-platform (Windows / macOS / Linux). Prebuilt installers in Releases.
>
> Happy to answer questions on the architecture, the MCP tool surface, or the threat model. Brutal feedback very welcome — especially from anyone who runs prod.
>
> Repo + installers: https://github.com/DLbury/clide

## How to engage in the thread (be present for the first 4–6 hours)

- Reply to every comment within ~30 min. HN rewards responsive authors.
- When someone says "why not just run Claude on the server?" — answer the trust model: credentials stay on your box, no lateral-movement surface if the AI session leaks.
- If someone finds a bug, thank them and fix it fast, then post the fix + commit link in-thread. This is worth more than the launch itself.
- Don't link your other posts / don't self-promote other things.

## Common objections to pre-empt (have these answers ready)

- **"Is Claude sending my terminal output to Anthropic?"** — Yes, the text output you let Claude read is part of the Claude Code conversation (same as any Claude Code session). What's *not* sent: your password, private key, sudo password — those never enter the AI path. Don't paste secrets into the AI panel; type them in the shell.
- **"Why not just tmux + a separate Claude?"** — You can, but then Claude can't see your live terminal and you copy-paste by hand. Clide's value is that the AI reads the *real* PTY output and runs commands back into it.
- **"Why a whole desktop app vs a CLI wrapper?"** — SFTP browsing, Monaco config editing, resource graphs, multi-tab split panes, and a non-invasive IDE bridge that doesn't touch your global shell rc.

## After it lands

- Post the HN link to your own X/Twitter and a Chinese community **only after** it's been up ~2hr and has some traction (avoid the "coordinated vote" smell).
- Screenshot the HN thread for the README "press" section later.

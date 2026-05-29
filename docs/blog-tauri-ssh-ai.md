# Building an AI-Powered SSH IDE with Tauri 2 and MCP

> How I built Clide -- an open-source desktop app that brings Claude Code AI into SSH terminal workflows.

## Why Another Terminal?

Existing terminal emulators are great at rendering text. But when you need to SSH into a remote server, edit files, run commands, AND get AI assistance -- you end up juggling 3-4 different tools. Clide was born from this frustration.

## The Tech Stack

- **Tauri 2** instead of Electron: ~10MB installer vs ~200MB, native performance, Rust backend
- **xterm.js** for terminal rendering with real PTY support
- **russh** for pure-Rust SSH implementation
- **Monaco Editor** for in-app code editing
- **Dockview** for flexible split-pane layouts

## Non-Invasive AI Integration

The key design decision: Clide does NOT modify your shell config. Instead of injecting shell hooks (like some AI terminals do), we use:

1. **IDE WebSocket Bridge**: A local WebSocket server that Claude Code CLI connects to via `--ide` mode
2. **MCP (Model Context Protocol)**: Standard tool protocol that lets Claude call `runShellCommand`, `readRemoteFile`, etc.
3. **Project-level config**: `.mcp.json` in the project directory, no global state pollution

This means:
- No changes to `~/.bashrc` or PowerShell Profile
- Works with any shell, any server
- Claude gets terminal context without shell hooks

## Architecture

```
Claude Code CLI --(WebSocket)--> IDE Bridge --(MCP)--> Clide Backend
                                                         |
                                                    PTY / SSH / SFTP
```

The bridge translates between Claude's IDE protocol and the MCP tools, giving Claude full access to the SSH session, remote files, and terminal output.

## What I Learned

1. **Tauri 2 is production-ready**: The Rust backend handles SSH connections, PTY management, and file transfers without breaking a sweat
2. **MCP is powerful but early**: The protocol is clean, but tooling is still maturing
3. **Non-invasive > deeply integrated**: Users don't want AI touching their shell config
4. **Cross-platform SSH is hard**: Different SSH servers, auth methods, and edge cases need careful handling

## Try It Out

Clide is open source under MIT. Install it, connect to your server, and let Claude help you debug, edit, and manage your remote development workflow.

- [GitHub: DLbury/clide](https://github.com/DLbury/clide)
- [Download Releases](https://github.com/DLbury/clide/releases)

---

*Keywords: Tauri 2, SSH client, Claude Code, MCP, AI terminal, remote development, open source IDE*

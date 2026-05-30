# Changelog

All notable changes to Clide will be documented in this file.

## [0.1.26] - 2026-05-30

### Fixed
- xterm resync duplicated shell output (commands appeared to run many times)
- Windows console windows flashing on startup and AI chat (hidden MCP/node spawns)
- Modal dialogs briefly flashing on app launch (render only when open)
- MCP shell command dedup within short window; disable text-extract fallback after MCP tools

## [0.1.25] - 2026-05-29

### Added
- Telnet and Serial terminal session types (cross-platform serial via tokio-serial)
- MCP preflight before Claude spawn; `incomplete` flag for long-running shell commands
- In-app alert/confirm dialogs (no browser `alert`/`confirm`)

### Fixed
- MCP stdio on Windows (`D:` / `\\?\` path) and launcher stdin/stdout piping
- Shell tool output capture for fast commands; stale completion idempotency
- IDE bridge reconnect noise; AI duplicate output and stream update depth issues
- MCP tools routed through left xterm shell instead of Rust-only PTY write

## [0.1.22] - 2026-05-28

### Added
- GitHub Actions CI/CD pipeline
- Cross-platform release builds (Windows, macOS, Linux)
- MCP project-level configuration support

### Fixed
- Various stability improvements

## [0.1.21] - 2026-05-20

### Fixed
- MCP startup issue on Linux (.deb)
- Resource path resolution for bundled MCP scripts

## [0.1.20] - 2026-05-15

### Added
- Initial public release
- SSH terminal with multi-tab and split-pane support
- SFTP remote file management
- Monaco editor integration
- Claude Code AI assistant with MCP tools
- IDE WebSocket bridge for non-invasive Claude integration
- Resource monitoring (CPU, memory, GPU, disk)
- Cross-platform support (Windows, macOS, Linux)

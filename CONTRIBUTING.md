# Contributing to Clide

Thanks for your interest in contributing to Clide! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/clide.git`
3. Create a branch: `git checkout -b feat/your-feature`
4. Install dependencies:
   ```bash
   npm ci
   npm ci --prefix view
   ```
5. Start development: `npm run dev:tauri`

## Development Environment

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) stable
- Platform dependencies: [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

### Project Layout

- `view/` -- Next.js frontend (React, Tailwind, xterm.js, Monaco, Dockview)
- `src-tauri/` -- Rust / Tauri backend (SSH, PTY, Claude bridge, MCP)
- `scripts/` -- MCP stdio forwarding scripts

## Submitting Changes

1. Ensure your code builds without errors: `npm run build:tauri`
2. Write clear commit messages
3. Push to your fork and open a Pull Request
4. Describe what you changed and why

## Reporting Issues

- Use [GitHub Issues](https://github.com/DLbury/clide/issues) for bug reports and feature requests
- Include your OS, Clide version, and steps to reproduce
- For SSH issues, include server OS and SSH config (redact sensitive info)

## Code Style

- **Rust**: Follow standard `rustfmt` formatting
- **TypeScript**: Follow the existing ESLint config in `view/`
- Keep changes focused -- one feature or fix per PR

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

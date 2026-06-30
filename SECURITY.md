# Security Policy

Clide is an ops terminal built around a core promise: **server credentials never leave your machine, and the AI never sees your passwords.** This document explains that boundary, what's in scope for vulnerability reports, and how to report them.

## Supported Versions

We ship security fixes for the latest released version only.

| Version | Supported          |
| ------- | ------------------ |
| latest `0.1.x` on [Releases](https://github.com/DLbury/clide/releases) | ✅ |
| older `0.1.x` | ❌ — please upgrade |

## Trust boundary (what Clide guarantees)

- SSH connections are established and maintained **only on your desktop** by the Tauri/Rust backend (`russh`). Private keys and passwords are held in process memory on your machine and are **never transmitted to Anthropic, any third party, or the Claude Code process**.
- The `sudo` password is typed by you into the left xterm PTY. It is **not** captured, logged, or forwarded to the MCP tools or Claude.
- The MCP `aiterm` server can only run commands in a shell session you have already opened and connected. It has no independent path to your SSH credentials.
- No agent software or extra SSH keys are required on remote servers.

If you believe you have found a way to break any of the above (for example: a credential leaking to the AI, a password being logged, or MCP running commands against a session you did not open), **please report it** — see below.

## Reporting a Vulneribility

**Please do NOT open a public GitHub issue for security reports.**

Instead, use one of these private channels:

1. **GitHub Private Security Advisory** (preferred): go to the
   [Security tab](https://github.com/DLbury/clide/security/advisories/new)
   and create a private advisory. This lets us collaborate privately and publish a CVE/credit when fixed.
2. **Email**: send details to the maintainer via the email on the GitHub profile
   `DLbury`. Encrypt with our PGP key if you need one (request the public key first).

Please include:

- Description of the issue and the affected component (PTY, SSH, MCP, IDE bridge, frontend).
- Steps to reproduce, or a minimal proof of concept.
- The Clide version and OS you tested on.
- What you observed vs. what you expected under the trust boundary above.

## Response timeline

- **Acknowledgement**: within 72 hours.
- **Initial assessment**: within 7 days.
- **Fix or mitigation**: target the next release; critical issues may get a patch release sooner.
- We will credit reporters in the release notes and advisory unless you prefer to remain anonymous.

## Out of scope

- Vulnerabilities in upstream dependencies (please report to the upstream project). We track and upgrade deps in normal releases.
- Issues that require already having full access to the user's machine (the threat model assumes a single-user desktop).
- Bugs that do not cross the trust boundary above (e.g. a UI cosmetic bug) — please file a regular [issue](https://github.com/DLbury/clide/issues) instead.

## Safe disclosure

We ask for responsible disclosure and a reasonable window before any public post. We commit to acknowledging good-faith reports and working with you on coordinated disclosure.

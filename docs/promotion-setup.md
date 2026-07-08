# Promotion Setup — one-time repo configuration

These settings are **not editable in git** — they live in GitHub's repo settings / API. They are the single biggest discoverability lever (people search GitHub by topic and see your description in result cards). Do this once, before any launch post.

Estimated time: 3 minutes.

## 1. Repo description + homepage (the text under the repo title)

Set a description that reads well in GitHub search cards and in Google results. Aim for ~120 chars.

**Recommended description:**
```
Secure AI ops terminal — manage servers with Claude Code over SSH without leaking passwords or distributing AI keys. Sudo stays in your hands.
```

**Homepage URL** (optional but recommended): point it at the README for now, or a future landing page.
```
https://github.com/DLbury/clide#readme
```

### Option A — Web UI
1. Go to <https://github.com/DLbury/clide>
2. Click the **⚙️ gear** at top-right of the "About" sidebar
3. Paste the description into **Description**
4. Paste the homepage into **Homepage URL**
5. (Topics also editable here — see step 2)

### Option B — GitHub API (needs a personal access token with `repo` scope)

```bash
# Set GH_TOKEN first: export GH_TOKEN=ghp_xxx   (Windows Git Bash)
curl -s -X PATCH https://api.github.com/repos/DLbury/clide \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{
    "description": "Secure AI ops terminal — manage servers with Claude Code over SSH without leaking passwords or distributing AI keys. Sudo stays in your hands.",
    "homepage": "https://github.com/DLbury/clide#readme",
    "topics": ["claude-code","mcp","ssh","terminal","sre","devops","ai-ops","sysadmin","remote-server-management","tauri","rust","claude","anthropic","mcp-server","developer-tools","security","sftp","ops","copilot","desktop-app"]
  }'
```

## 2. Topics (the tags under the description)

GitHub allows up to **20** topics. These directly drive GitHub topic-page browse traffic. The set below covers all four audiences (SRE / Claude Code / Tauri / security) and the key tech keywords.

```
claude-code  mcp  ssh  terminal  sre  devops  ai-ops  sysadmin
remote-server-management  tauri  rust  claude  anthropic  mcp-server
developer-tools  security  sftp  ops  copilot  desktop-app
```

Add them in the Web UI "About" gear → **Topics** field (space-separated), or via the API call above.

## 3. Enable Discussions (community surface)

SREs ask questions; issues feel heavy for "how do I…". Discussions give a low-friction Q&A surface that also indexes in search.

1. **Settings → General → Features → Discussions** → enable.
2. Create categories: *Announcements*, *Q&A*, *Show and tell*, *Ideas*.

## 4. Enable the Sponsor button

`.github/FUNDING.yml` is already created. To make the "Sponsor" button work:
- Enable GitHub Sponsors at <https://github.com/sponsors/DLbury>, **or**
- edit `.github/FUNDING.yml` to use another provider (`patreon`, `ko_fi`, `custom: <url>`).

## 5. Releasing cadence (the gift that keeps giving)

Each tag triggers the release workflow. Every release is a legitimate reason to re-post a short summary to V2EX / Reddit / X. See `docs/release-announcement-template.md` (created in Tier 3) for the bilingual one-liner to copy-paste.

---

## Quick checklist

- [ ] Description set
- [ ] Homepage URL set
- [ ] 20 topics added
- [ ] Discussions enabled
- [ ] Sponsors / FUNDING wired
- [ ] `docs/assets/demo.gif` recorded (see `demo-recording.md`) and embedded in README

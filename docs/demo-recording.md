# Demo Recording Storyboard

A 60–90 second screen recording that shows Clide's core value: **the AI drives the left SSH shell while your passwords and sudo credentials never leave your hands.** This is the single highest-leverage asset for converting README visitors into stars.

Drop the final GIF at `docs/assets/demo.gif` (and/or a `demo.mp4` attached to a release). Once `docs/assets/demo.gif` exists, replace the "See it in action" note in `README.md` / `README_ZH.md` with:

```html
<p align="center">
  <img src="docs/assets/demo.gif" alt="Clide demo: AI troubleshooting a server over SSH without exposing passwords" width="900">
</p>
```

## Setup before recording

- Use a **disposable VM or test server** (e.g. a local multipass/Vagrant box, or a cloud $5 instance). **Do not record real production secrets.**
- OS shown: pick the one your audience uses. For SRE, **Linux + a tiling-ish window** reads best; macOS is fine too.
- Screen resolution: **1920×1200** or higher, Clide window maximized so the three panes (shell / files+monitor / AI) are all visible.
- Hide personal info: use a dummy hostname like `web-prod-01`, dummy user `ops`.
- Record at 30fps, then export a GIF ≤ ~8MB (tools: `ffmpeg` + `gifsicle`, or ScreenToGif on Windows).

## Scenes (one continuous take, ~75s)

| # | Time | Action | Caption on screen |
|---|------|--------|-------------------|
| 1 | 0–6s | Launch Clide. Double-click the `web-prod-01` SSH profile in the sidebar. | "Connect via SSH — password stays on your machine" |
| 2 | 6–14s | Type the SSH password (or 2FA) **in the left xterm**. Land on the shell prompt. | "You log in. Claude never sees the password." |
| 3 | 14–20s | In the right AI panel, type: *"This box feels slow — check load and top processes."* | "Ask the AI to investigate" |
| 4 | 20–34s | Claude calls `runShellCommand("uptime")` then `runShellCommand("ps aux --sort=-%cpu | head")`. The command + output appear **live in the left shell**. | "AI runs commands in your real shell — same PTY as manual typing" |
| 5 | 34–48s | Claude wants disk usage and suggests `sudo du -sh /var/* | sort -rh | head`. The sudo prompt appears in the left shell. **You** type the sudo password. The command runs. | "sudo? You type the password — AI can't see it" |
| 6 | 48–60s | Switch to the center pane: SFTP browse `/etc`, open `nginx/nginx.conf` in the Monaco editor, edit + save. | "Browse & edit remote files with Monaco" |
| 7 | 60–70s | Show the resource monitor card (CPU / memory / disk) updating. | "Live resource monitoring, separate channel — never blocks your shell" |
| 8 | 70–75s | End frame: Clide logo + text "Secure SSH + sudo with Claude Code · ⭐ Star on github.com/DLbury/clide" | "Star on GitHub" |

## Capturing the GIF

```bash
# From a recorded mp4 (Linux/macOS with ffmpeg + gifsicle)
ffmpeg -i demo.mp4 -vf "fps=15,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 demo.gif
gifsicle -O3 --colors 128 demo.gif -o docs/assets/demo.gif
```

On Windows, [ScreenToGif](https://www.screentogif.com/) can record and export directly.

## Tips for the SRE audience

- Keep it **honest**: show real terminal output, not staged text. SREs spot fake terminals instantly and bounce.
- The **password-in-left-shell** moment (scene 5) is the whole pitch — linger on it for 2–3 seconds with the caption visible.
- No voiceover needed; captions are enough and travel better across languages.
- After recording, post the same GIF on V2EX / 掘金 / Reddit / X as the video preview — it auto-plays inline and is your best click-through asset.

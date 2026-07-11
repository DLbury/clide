import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()
const width = 1536
const height = 1024

function esc(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function lines(items, x, y, size = 17, lineHeight = 30, color = '#67f49a', mono = true) {
  return items
    .map((item, index) => {
      const opacity = item.opacity ?? 1
      const fill = item.color ?? color
      const text = typeof item === 'string' ? item : item.text
      return `<text x="${x}" y="${y + index * lineHeight}" fill="${fill}" opacity="${opacity}" font-size="${size}" font-family="${mono ? 'JetBrains Mono, IBM Plex Mono, Consolas, monospace' : 'Inter, Arial, sans-serif'}">${esc(text)}</text>`
    })
    .join('\n')
}

function fileRow(label, x, y, active = false, depth = 0) {
  const px = x + depth * 22
  return `
    ${active ? `<rect x="${x - 14}" y="${y - 21}" width="310" height="34" rx="8" fill="#21302c" stroke="#315545"/>` : ''}
    <text x="${px}" y="${y}" fill="${active ? '#f4fff8' : '#b9c2be'}" font-size="17" font-family="Inter, Arial, sans-serif">${esc(label)}</text>
  `
}

function metric(label, value, x, y, pct, color = '#34d399') {
  const barWidth = 132
  return `
    <text x="${x}" y="${y}" fill="#88918e" font-size="13" font-family="JetBrains Mono, Consolas, monospace">${esc(label)}</text>
    <text x="${x + 92}" y="${y}" fill="#edf8f2" font-size="13" font-family="JetBrains Mono, Consolas, monospace" text-anchor="end">${esc(value)}</text>
    <rect x="${x}" y="${y + 10}" width="${barWidth}" height="6" rx="3" fill="#1e2523"/>
    <rect x="${x}" y="${y + 10}" width="${Math.round(barWidth * pct)}" height="6" rx="3" fill="${color}"/>
  `
}

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="bgGlow" cx="52%" cy="8%" r="74%">
      <stop offset="0%" stop-color="#1d7c5a" stop-opacity=".34"/>
      <stop offset="42%" stop-color="#0d2d25" stop-opacity=".42"/>
      <stop offset="100%" stop-color="#07090a"/>
    </radialGradient>
    <linearGradient id="window" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#151a1c"/>
      <stop offset="100%" stop-color="#0b0e0f"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#111719"/>
      <stop offset="100%" stop-color="#0a0d0e"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#86efac"/>
      <stop offset="100%" stop-color="#22c55e"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="36" stdDeviation="34" flood-color="#000000" flood-opacity=".55"/>
    </filter>
    <filter id="soft">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#ffffff" stroke-opacity=".035" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="1536" height="1024" fill="#07090a"/>
  <rect width="1536" height="1024" fill="url(#bgGlow)"/>
  <rect width="1536" height="1024" fill="url(#grid)"/>
  <circle cx="1300" cy="160" r="210" fill="#34d399" opacity=".12" filter="url(#soft)"/>
  <circle cx="170" cy="820" r="260" fill="#10b981" opacity=".10" filter="url(#soft)"/>

  <g transform="translate(92 64)">
    <rect x="0" y="0" width="160" height="160" rx="42" fill="#11181a" stroke="#2b3335" stroke-width="2"/>
    <path d="M50 56 H96 C116 56 132 72 132 92 C132 112 116 128 96 128 H50 Z" fill="url(#accent)"/>
    <path d="M74 77 L99 100 L74 123" fill="none" stroke="#0c1213" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M104 124 H132" stroke="#0c1213" stroke-width="10" stroke-linecap="round"/>
  </g>

  <text x="292" y="120" fill="#72f0a0" font-size="78" font-weight="800" letter-spacing="-3" font-family="Inter, Arial, sans-serif">Clide</text>
  <text x="292" y="167" fill="#e9f8ef" opacity=".96" font-size="34" font-weight="650" font-family="Inter, Arial, sans-serif">Secure AI SSH terminal</text>
  <text x="292" y="206" fill="#a9b6b1" font-size="22" font-family="Inter, Arial, sans-serif">Local AI agents operate your live PTY through MCP. Credentials stay on your desktop.</text>

  <g font-family="Inter, Arial, sans-serif" font-size="18" fill="#d7e8df">
    <rect x="918" y="94" width="174" height="40" rx="20" fill="#10231d" stroke="#235c44"/>
    <text x="945" y="120">No server agent</text>
    <rect x="1110" y="94" width="158" height="40" rx="20" fill="#10231d" stroke="#235c44"/>
    <text x="1138" y="120">Safe sudo</text>
    <rect x="1286" y="94" width="122" height="40" rx="20" fill="#10231d" stroke="#235c44"/>
    <text x="1315" y="120">MCP</text>
  </g>

  <g transform="translate(52 250)" filter="url(#shadow)">
    <rect x="0" y="0" width="1432" height="706" rx="24" fill="url(#window)" stroke="#2a3234" stroke-width="2"/>
    <rect x="0" y="0" width="1432" height="56" rx="24" fill="#171d20"/>
    <path d="M0 56 H1432" stroke="#293134"/>
    <circle cx="28" cy="28" r="8" fill="#ff5f57"/>
    <circle cx="54" cy="28" r="8" fill="#ffbd2e"/>
    <circle cx="80" cy="28" r="8" fill="#28c840"/>
    <text x="116" y="35" fill="#eef7f2" font-size="19" font-weight="650" font-family="Inter, Arial, sans-serif">Clide - production SSH ops</text>
    <text x="1240" y="34" fill="#34d399" font-size="14" font-family="JetBrains Mono, Consolas, monospace">Claude Code MCP connected</text>

    <g transform="translate(0 56)">
      <rect x="0" y="0" width="596" height="650" fill="url(#panel)"/>
      <rect x="596" y="0" width="318" height="650" fill="#101517"/>
      <rect x="914" y="0" width="518" height="650" fill="#0d1112"/>
      <path d="M596 0 V650 M914 0 V650" stroke="#273033" stroke-width="2"/>

      <g transform="translate(16 16)">
        <rect x="0" y="0" width="256" height="40" rx="10" fill="#1b2325" stroke="#293638"/>
        <circle cx="20" cy="20" r="6" fill="#34d399"/>
        <text x="38" y="26" fill="#dcece5" font-size="16" font-family="Inter, Arial, sans-serif">SSH: prod-api-03</text>
        <text x="228" y="26" fill="#8e9a96" font-size="16" font-family="Inter, Arial, sans-serif">x</text>
        <rect x="268" y="0" width="44" height="40" rx="10" fill="#121819" stroke="#293638"/>
        <text x="283" y="27" fill="#a7b5b0" font-size="24" font-family="Inter, Arial, sans-serif">+</text>
      </g>

      <g transform="translate(24 86)">
        ${lines([
          { text: 'Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0 x86_64)' },
          { text: 'Last login: Fri Jul 10 09:42:18 2026 from 10.0.4.7', opacity: .78 },
          { text: 'root@prod-api-03:/srv/payments# systemctl status api.service' },
          { text: '● api.service - payments api', color: '#d8ffe6' },
          { text: '   Loaded: loaded (/etc/systemd/system/api.service; enabled)', color: '#9af7bd' },
          { text: '   Active: active (running) since Fri 2026-07-10 09:38:04 CST', color: '#73f5a2' },
          { text: '   Memory: 421.8M   CPU: 2min 14.308s', color: '#d5e2dd' },
          { text: 'root@prod-api-03:/srv/payments# journalctl -u api -n 80 --no-pager', opacity: .92 },
          { text: 'Jul 10 09:44:12 api[1842]: p95 latency 418ms, queue=37', color: '#f8d38a' },
          { text: 'Jul 10 09:44:17 api[1842]: recovered upstream pool after 2 retries', color: '#d5e2dd' },
          { text: 'root@prod-api-03:/srv/payments# ', color: '#67f49a' }
        ], 0, 0, 16, 34)}
        <rect x="265" y="333" width="10" height="24" fill="#67f49a"/>
      </g>

      <g transform="translate(24 548)">
        <rect x="0" y="0" width="548" height="46" rx="12" fill="#101719" stroke="#283335"/>
        <text x="18" y="29" fill="#8c9894" font-size="14" font-family="JetBrains Mono, Consolas, monospace">AI command requires sudo. Type password in terminal only.</text>
        <text x="460" y="29" fill="#34d399" font-size="14" font-family="Inter, Arial, sans-serif">Visible PTY</text>
      </g>

      <g transform="translate(622 26)">
        <text x="0" y="0" fill="#edf8f2" font-size="18" font-weight="700" font-family="Inter, Arial, sans-serif">Remote files</text>
        <text x="225" y="0" fill="#7c8985" font-size="16" font-family="JetBrains Mono, Consolas, monospace">SFTP</text>
        <g transform="translate(0 40)">
          ${fileRow('▾ /srv/payments', 0, 0, false, 0)}
          ${fileRow('▾ app', 0, 38, false, 1)}
          ${fileRow('api.py', 0, 76, true, 2)}
          ${fileRow('config.yaml', 0, 114, false, 2)}
          ${fileRow('routes.py', 0, 152, false, 2)}
          ${fileRow('▸ logs', 0, 190, false, 1)}
          ${fileRow('systemd/api.service', 0, 228, false, 1)}
          ${fileRow('.env.example', 0, 266, false, 1)}
        </g>
        <rect x="-12" y="342" width="294" height="196" rx="16" fill="#0b1011" stroke="#273134"/>
        <text x="8" y="374" fill="#edf8f2" font-size="17" font-weight="700" font-family="Inter, Arial, sans-serif">Host monitor</text>
        ${metric('CPU', '42%', 8, 410, .42)}
        ${metric('MEM', '6.8G', 8, 462, .68, '#60a5fa')}
        ${metric('DISK', '71%', 8, 514, .71, '#f59e0b')}
        ${metric('NET', '18M/s', 152, 410, .28, '#34d399')}
        ${metric('GPU', '1.2G', 152, 462, .22, '#a78bfa')}
        <text x="152" y="536" fill="#87938f" font-size="13" font-family="JetBrains Mono, Consolas, monospace">exec channel - non blocking</text>
      </g>

      <g transform="translate(944 26)">
        <text x="0" y="0" fill="#edf8f2" font-size="18" font-weight="700" font-family="Inter, Arial, sans-serif">AI agent</text>
        <text x="340" y="0" fill="#34d399" font-size="14" font-family="JetBrains Mono, Consolas, monospace">aiterm MCP</text>

        <rect x="0" y="34" width="444" height="72" rx="16" fill="#172022" stroke="#2d3a3d"/>
        <text x="22" y="64" fill="#edf8f2" font-size="17" font-family="Inter, Arial, sans-serif">Why is api.service latency rising?</text>
        <text x="22" y="90" fill="#8e9a96" font-size="14" font-family="Inter, Arial, sans-serif">Read the live terminal and propose safe checks.</text>

        <rect x="0" y="128" width="444" height="118" rx="16" fill="#0f1516" stroke="#294039"/>
        <text x="22" y="160" fill="#34d399" font-size="14" font-family="JetBrains Mono, Consolas, monospace">tool: getTerminalContext</text>
        <text x="22" y="190" fill="#c5d4ce" font-size="16" font-family="Inter, Arial, sans-serif">I can see p95 latency and queue growth.</text>
        <text x="22" y="218" fill="#8f9d98" font-size="15" font-family="Inter, Arial, sans-serif">Next checks stay inside the opened PTY.</text>

        <rect x="0" y="270" width="444" height="160" rx="16" fill="#101617" stroke="#294039"/>
        <text x="22" y="302" fill="#34d399" font-size="14" font-family="JetBrains Mono, Consolas, monospace">command approval</text>
        <text x="22" y="333" fill="#edf8f2" font-size="16" font-family="Inter, Arial, sans-serif">Run: journalctl -u api -n 80 --no-pager</text>
        <text x="22" y="361" fill="#8f9d98" font-size="15" font-family="Inter, Arial, sans-serif">Risk: read-only. No sudo password captured.</text>
        <rect x="22" y="384" width="104" height="32" rx="16" fill="#34d399"/>
        <text x="51" y="406" fill="#052e1f" font-size="14" font-weight="700" font-family="Inter, Arial, sans-serif">Approve</text>
        <rect x="138" y="384" width="86" height="32" rx="16" fill="#171f20" stroke="#3a4648"/>
        <text x="162" y="406" fill="#d0ddd7" font-size="14" font-family="Inter, Arial, sans-serif">Deny</text>

        <rect x="0" y="454" width="444" height="84" rx="16" fill="#172022" stroke="#2d3a3d"/>
        <text x="22" y="486" fill="#e8f7ef" font-size="16" font-family="Inter, Arial, sans-serif">Finding: upstream pool recovered, but queue is</text>
        <text x="22" y="512" fill="#e8f7ef" font-size="16" font-family="Inter, Arial, sans-serif">still elevated. Check DB pool and slow queries.</text>

        <rect x="0" y="562" width="444" height="46" rx="12" fill="#0b1011" stroke="#283335"/>
        <text x="18" y="592" fill="#74827d" font-size="14" font-family="Inter, Arial, sans-serif">Ask about this server...</text>
        <path d="M410 578 l18 8 -18 8 4 -8 z" fill="#34d399"/>
      </g>
    </g>
  </g>

  <g transform="translate(88 966)" font-family="Inter, Arial, sans-serif">
    <text x="0" y="0" fill="#7e8a86" font-size="18">SSH + SFTP + monitoring + local AI agents</text>
    <text x="1080" y="0" fill="#34d399" font-size="18" font-weight="700">Passwords never enter the AI path</text>
  </g>
</svg>
`

const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer()

const targets = [
  path.join(root, 'landing/assets/hero.png'),
  path.join(root, 'docs/assets/readme-hero.png'),
]

await Promise.all(targets.map(target => writeFile(target, png)))

console.log(`Generated ${targets.length} hero images (${width}x${height})`)

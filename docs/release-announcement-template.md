# 发版公告模板（双语，每次发版复用）

每次打 tag 触发 release 后，挑下面对应模板**改三个变量**（版本号、标题、要点）即可贴各平台。短而克制——社区对「每次发版都长篇」会脱敏。

**变量替换：**
- `{{VER}}` → 如 `0.1.69`
- `{{HIGHLIGHTS}}` → 2–4 条本次亮点（从 `CHANGELOG.md` 摘）
- `{{LINK}}` → release 链接 `https://github.com/DLbury/clide/releases/tag/v{{VER}}`

---

## V2EX / 短帖（中文）

```
Clide v{{VER}} 发布：{{一句话亮点，≤20字}}

{{HIGHLIGHTS 每条一行，带 - }}

Clide = 安全地用 Claude Code 运维服务器（凭据留本机，sudo 你自己敲）。
{{LINK}}
```

## 掘金 / 微博动态（中文，稍长）

```
Clide v{{VER}} 更新 🔧

{{HIGHLIGHTS}}

mit 开源 / Win·macOS·Linux 安装包：
{{LINK}}

#ClaudeCode #运维 #SRE
```

## Reddit / r/ClaudeAI（英文，仅当有用户关心的功能时发）

```
Clide v{{VER}} — {{one-line highlight}}

{{HIGHLIGHTS}}

MIT, Win/macOS/Linux: {{LINK}}
```

## X / Twitter（英文，单条即可，不每次都发线程）

```
Clide v{{VER}}:

{{HIGHLIGHTS, each ≤1 line}}

MIT · Win/macOS/Linux · {{LINK}}
```

## GitHub Release 正文（双语，贴 release notes）

```
## v{{VER}}

### Highlights
{{HIGHLIGHTS}}

### 中文摘要
{{HIGHLIGHTS 中文}}

---

⭐ If Clide helps, consider starring: https://github.com/DLbury/clide
📦 All platforms: see Assets below.
```

---

## 节奏守则

- **不是每个 patch 版本都发各平台**：只有含「用户可感知」的功能 / 重要修复时，才往 Reddit / 掘金发。V2EX / X 可以更轻量，每次都行。
- **同一周不要在多个平台重复同一句话**——算法和人都讨厌复读。给每条加一个不同的钩子（安全 / 效率 / 新功能）。
- 发版当天把 release 链接置顶在 README 顶部一行（或 pinned issue），便于新访客看到项目在活跃迭代——活跃本身就是 star 转化率。

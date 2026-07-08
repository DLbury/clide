# 技术博客稿（安全切入）

**标题候选（选一个）：**
- 《别把 root 密码交给 AI：一种让 Claude Code 安全运维服务器的架构》
- 《AI 运维的凭据困境，与一种本地中继解法》
- *English:* "Letting AI run your servers without handing it the root password"

**用途：** 可发个人博客 / Medium / 掘金 / 知乎专栏。约 1800–2200 字。下面是完整可发版，按需配 README 里的架构图与对比表。

---

# 别把 root 密码交给 AI：一种让 Claude Code 安全运维服务器的架构

## 一个尴尬的矛盾

Claude Code 已经能读代码、改文件、跑测试，能力强到很多团队开始把它当半个工程师用。但当你真的让它去碰服务器——查磁盘、看负载、重启服务——你会撞上一堵墙：

**你想给 AI 足够的权限去操作服务器，但「给得起又放心」的方式几乎没有。**

常见的三种玩法，每一种都有硬伤：

1. **给每台服务器配 AI 的公钥。** 一次 AI 端泄露，所有机器横向沦陷。AI 的凭据是高价值目标，分发的面越广越危险。
2. **把明文密码告诉 Claude。** 密码离开本机，进入对话上下文，上传到 Anthropic。任何凭据一旦离开你的边界，就不再属于你。
3. **配置无密码 sudo。** 安全审计直接红牌。一旦有进程能在该账号下执行，就等于有了 root。

三条路都把「便利」建立在「降低安全水位」上。这不是 Claude 的问题，是架构的问题。

## 我想要的安全模型

我想保留两样东西，同时都要：

- **AI 的脑子**：能读实时终端输出、能跑命令、能基于上下文给建议。
- **传统 SSH 客户端的安全模型**：凭据只在本机，`sudo` 由我亲手输，服务器上不装任何东西。

把它们合起来的关键，是认清一件事：**AI 不需要「持有」凭据，它只需要「使用」你已打开的会话。**

## 本地中继架构

我据此做了 [Clide](https://github.com/DLbury/clide)（MIT，Tauri 2 桌面应用）。架构很简单：

```
你的桌面（Clide）
  ├─ SSH 连接  ← 仅本机，russh 建立，私钥/密码在进程内存
  ├─ 左侧 xterm ← 你手敲登录，含密码 / 2FA / sudo
  └─ IDE 桥接 + MCP
        ↑
本机 Claude Code（--ide）
  └─ MCP aiterm：runShellCommand / getTerminalContext / readRemoteFile ...
```

Claude Code 只在你本机运行。它通过一个本地 IDE 桥接（WebSocket on `127.0.0.1`）和一个叫 `aiterm` 的 MCP 服务器，把命令下发到**左侧那条你已经登录的 xterm**——和你手敲用的是同一条 PTY。AI 读终端输出回来，帮你分析。

注意几个边界：

- **SSH 连接由本机 Rust 后端建立维护**，私钥和密码不离开进程内存，不进 Claude 对话。
- **MCP 只能操作你已打开并连接的会话**，它没有独立的凭据路径，连不上你没登录的机器。
- **服务器零安装、零额外公钥**，没有任何 agent 软件留痕。

## `sudo` 这一步是关键

很多人能接受「AI 跑命令」，但卡在 `sudo`：要么配无密码 sudo（安全红线），要么把 root 密码交给 AI（不可接受）。

Clide 的做法是：当 AI 判断需要 `sudo` 时，命令下发给左侧 Shell，**sudo 提示符出现在你的终端里**，由**你自己**输入密码。MCP 工具不捕获、不转发、不记录这个输入。AI 看到的是命令执行后的输出，看不到密码。

这一步把「AI 帮你排障」和「root 凭据不出手」拆成了两件互不污染的事。

## 一个真实场景

> 你：这台机器磁盘快满了，帮我查一下
>
> AI → `runShellCommand("df -h")` → 左侧 Shell 执行，输出回传
>
> AI → `runShellCommand("sudo du -sh /var/* | sort -rh | head")`
>
> 你：在左侧 Shell 输 sudo 密码（AI 看不到）
>
> AI：根因是 `/var/log/app.log` 占了 80G，建议 logrotate …

全程你看得见每条命令、每行输出，需要授权的地方由你亲手完成。

## 诚实说威胁模型

没有任何方案是「绝对安全」，把话说清楚：

- **会**进入 Claude 对话的：你让 AI 读取的**终端输出文本**（这和任何 Claude Code 用法一样）。所以别把 secret 粘进右侧 AI 面板，需要时在 Shell 里用环境变量或文件。
- **不会**进入 AI 路径的：SSH 密码、私钥、sudo 密码。这些只敲在 xterm 里。
- **威胁假设**：单用户桌面环境。如果你的本机已经被攻破，任何本机凭据库都保不住你——这是更上游的问题。

完整说明见仓库的 [SECURITY.md](https://github.com/DLbury/clide/blob/main/SECURITY.md)。

## 和其他方案的区别

| | SSH 客户端 + 另开 Claude 窗口 | Claude Code 直连 SSH | Clide |
|---|---|---|---|
| AI 看实时终端输出 | ❌ 手工粘贴 | ✅ | ✅ 同一条 PTY |
| 凭据 | ✅ 留本机 | ❌ 公钥分发 / 密码给 AI | ✅ 留本机 |
| sudo / 2FA | ✅ 自己处理 | ❌ 难安全 | ✅ 你敲，AI 看不到 |
| 服务器装 agent | ✅ 不需要 | ❌ 必需 | ✅ 不需要 |

一句话：**保留传统 SSH 客户端的安全模型，加上直连 Claude Code 的 AI 上下文，且不暴露凭据。**

## 试一试

Clide 是 MIT 开源、跨平台（Windows / macOS / Linux），安装包在 [Releases](https://github.com/DLbury/clide/releases)。

1. 下载安装，侧边栏配好 SSH Profile
2. 双击连接，在左侧终端登录
3. 本机装好并登录 Claude Code CLI，确认 IDE 桥接就绪
4. 对 AI 描述问题，看它在左侧 Shell 跑命令、读输出、给建议

仓库与文档：https://github.com/DLbury/clide

如果你是运维 / SRE / 后端，我特别想要你的反馈：这个信任模型够不够？离让你放心给团队用还差什么？与其给个假安全感，我宁可现在被喷——去 issue 区开喷就行。

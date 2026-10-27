# WeChat Claude Code Bridge

<p align="center">
  <strong>Chat with Claude Code in WeChat, just like texting a friend</strong>
</p>

<p align="center">
  <a href="https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="https://skills.sh/Wechat-ggGitHub/wechat-claude-code"><img src="https://img.shields.io/badge/skills.sh-view_page-blue?style=flat-square" alt="skills.sh"></a>
  <a href="README_en.md"><img src="https://img.shields.io/badge/Lang-English-lightgrey?style=flat-square" alt="English"></a>
</p>

扫码绑定微信后，你的微信里会多出一个好友。给它发消息，消息会自动转发给你电脑上运行的 Claude Code，回复也会实时推送到微信。支持文字、图片、语音、文件的收发。

<img width="3018" height="1216" alt="ScreenShot_2026-06-10_211251_410" src="https://github.com/user-attachments/assets/2ba4c53b-9c63-4ffd-bd0a-71935a6eabec" />

## 核心亮点
| | |
|---|---|
| **扫码即用** | 不用注册账号，不用部署服务器。微信扫码绑定，一分钟搞定。数据全在本地，隐私有保障。 |
| **消息不刷屏** | 只推送核心信息——进度、结果、关键决策。工具调用、中间过程等噪音自动过滤，阅读体验清爽。 |
| **"对方正在输入中..."** | Claude 在处理任务时，微信顶部会显示输入状态，随时感知它在干活。 |
| **电脑手机体验一致** | 手机端和电脑端 Claude Code 行为完全相同——同样的编排逻辑、同样的输出效果。不是两个割裂的 AI。 |
| **文件双向收发** | 发图片、Word、PDF 给 Claude 分析；Claude 生成的文件也会直接推送到微信，不用回到电脑前查看。 |
| **超时安抚** | 任务超过 5 分钟没响应？它会自动发一条消息告诉你还在干，不会让你对着空白聊天框干等。 |

## 快速安装

代码和 skill 文档分装在两个地方：

| | 位置 | 内容 |
|---|---|---|
| **运行目录** | 你 clone 出来的代码目录 | 源码、`dist/`（编译产物）、`node_modules/`（依赖）、守护进程 |
| **skill 目录** | `~/.claude/skills/wechat-claude-code/` | 只有 skill 文档，通过**目录联接**指向运行目录里的 `skill/` |

> Claude 全局目录可以用 `CLAUDE_CONFIG_DIR` 环境变量改，默认是 `~/.claude`。
> skill 目录里因此不含任何运行代码，而改了文档立刻生效。

```bash
# 1. clone 代码到你自己选的目录（下面用 ~/wechat-claude-code 举例）
git clone https://github.com/KobeBryant-24/wechat-claude-code-refined.git ~/wechat-claude-code
cd ~/wechat-claude-code && npm install

# 2. 扫码绑定微信
npm run setup

# 3. 把 skill 装进 Claude 全局目录
npm run skill:install

# 4. 注册守护进程（开机自启、崩溃自动重启）
npm run daemon -- start        # macOS / Linux —— 这一步会写好 launchd / systemd 配置并拉起
npm run daemon:reinstall       # Windows（需要管理员权限的 Git Bash）
```

第 3 步会把运行目录的位置记进 `~/.wechat-claude-code/install.json`，skill 文档靠它找到该在哪儿执行命令。

> 代码目录和 skill 目录是分开的，所以 `npx skills add` 那种「整仓装进 skills 目录」的方式不适用 —— 那样代码会和文档混在一起。

## 快速开始

### 1. 扫码绑定

```bash
cd <运行目录>     # 你 clone 代码的那个目录
npm run setup
```

弹出二维码，用微信扫码。

### 2. 启动服务

```bash
npm run daemon -- start
```

macOS 下自动注册 launchd，Linux 下自动写 systemd user unit，开机自启、崩溃自动重启。Windows 上这一步用 `npm run daemon:reinstall`（管理员权限）。

### 3. 开始聊天

打开微信，给你新出现的那个"好友"发条消息试试。

### 管理服务

```bash
npm run daemon -- status   # 查看运行状态
npm run daemon -- stop     # 停止服务
npm run daemon -- restart  # 重启服务（更新代码后使用）
npm run daemon -- logs     # 查看日志
```

> Windows 上没有 `restart` 子命令，改代码后用 `npm run redeploy`（= build + 热重启子进程）。

## 微信端命令

直接在微信聊天中发送即可：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话，开始新对话 |
| `/stop` | 停止当前任务 |
| `/model <名称>` | 切换 Claude 模型 |
| `/prompt <内容>` | 设置系统提示词（如"用中文回答"） |
| `/cwd <路径>` | 切换工作目录 |
| `/skills` | 查看已安装的 Skill |
| `/status` | 查看当前会话状态 |
| `/history [数量]` | 查看最近对话记录 |
| `/compact` | 压缩上下文，开始新 CLI 会话 |
| `/reset` | 完全重置（包括工作目录等设置） |
| `/undo [数量]` | 撤销最近几条对话 |
| `/<skill> [参数]` | 触发任意已安装的 Skill |

## 工作原理

```
微信（手机） ←→ ilink Bot API ←→ Node.js 守护进程 ←→ Claude Code CLI（本地）
```

守护进程通过长轮询监听微信消息，转发给本地 `claude` CLI 处理，回复实时流式推送回微信。全程跑在你自己电脑上。

## 后续计划

- **消息队列优化** — 连续发多条指令时，回复容易串。正在研究更好的队列策略，也欢迎讨论。
- **电脑休眠不中断** — 利用 macOS 的 `caffeinate` 命令阻止系统睡眠，合上盖子也能响应微信消息。
- **接续电脑会话** — 在电脑上聊了很久，出门想接着聊。计划支持从当前电脑端的 Claude Code 会话直接续聊，工作空间和上下文保持一致。

## 前置条件

- Node.js >= 18
- macOS / Linux / Windows
- 个人微信账号
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 并完成认证

> **提示：** Claude Code 支持第三方 API 提供商（OpenRouter、AWS Bedrock 等），设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_API_KEY` 即可。

## 数据目录

所有数据存储在 `~/.wechat-claude-code/`，**与运行目录无关**（代码目录随便挪，配置和账号都还在）：

```
~/.wechat-claude-code/
├── accounts/       # 微信账号凭证
├── config.json     # 全局配置
├── sessions/       # 会话数据
├── install.json    # 运行目录 / skill 目录的位置（由 npm run skill:install 写入）
└── logs/           # 运行日志（每日轮转，保留 30 天）
```

## License

[MIT](LICENSE)

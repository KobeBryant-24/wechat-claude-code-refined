---
name: wechat-claude-code
description: 微信消息桥接 - 在微信中与 Claude Code 聊天。支持文字对话、图片识别、实时进度推送、斜杠命令。
---

# WeChat Claude Code Bridge

通过个人微信与本地 Claude Code 进行对话。

## 运行目录

**不要把运行目录写死在任何地方 —— 先解析出来再用。**

运行目录 = 用户 clone 本项目的那份代码，`src/`（源码）、`dist/`（编译产物）、`node_modules/`（依赖）和守护进程都在里面。skill 目录（Claude 全局目录）里**只有本文档**，不含任何运行代码。

安装流程会把运行目录记在数据目录里：

```bash
cat ~/.wechat-claude-code/install.json
```

> 数据目录默认是 `~/.wechat-claude-code`，设了 `WCC_DATA_DIR` 就在那儿。

```json
{
  "projectDir": "<运行目录>",
  "skillDir": "<Claude 全局目录>/skills/wechat-claude-code",
  "installedAt": "2026-10-27T00:00:00.000Z"
}
```

- `projectDir` 就是运行目录 —— 下文所有命令都在它里面执行。
- 文件不存在 → 还没装过，走下面的「安装」流程。
- `projectDir` 指向的目录不存在（代码被移动或删了）→ 重新安装。

**下文出现的 `<运行目录>` 一律替换成解析出来的 `projectDir`。**

## 前置条件

- Node.js >= 18
- 个人微信账号（需扫码绑定）
- 已安装 Claude Code CLI（守护进程每条消息会 spawn 一次 `claude`，凭据由 CLI 自己从 `~/.claude/settings.json` 解析）
- 守护进程由系统服务托管：macOS 用 launchd，Linux 用 systemd，Windows 用 node-windows 服务

## 安装

代码和文档分装在两个地方：

| | 位置 | 内容 |
|---|---|---|
| 运行目录 | 用户 clone 出来的代码目录 | 源码、`dist/`、`node_modules/`、守护进程 |
| skill 目录 | `<Claude 全局目录>/skills/wechat-claude-code/` | 只有本文档（目录联接，指向运行目录里的 `skill/`） |

`<Claude 全局目录>` = `CLAUDE_CONFIG_DIR` 环境变量指向的目录，没设置就是 `~/.claude`。

```bash
# 1. clone 代码（<运行目录> 自己定，比如 ~/wechat-claude-code）
git clone https://github.com/KobeBryant-24/wechat-claude-code-refined.git <运行目录>
cd <运行目录> && npm install

# 2. 扫码绑定微信
npm run setup

# 3. 把 skill 装进 Claude 全局目录（目录联接，之后改文档立即生效）
npm run skill:install

# 4. 注册守护进程
npm run daemon -- start        # macOS / Linux —— 这一步会写好 launchd / systemd 配置并拉起
npm run daemon:reinstall       # Windows（需要管理员权限的 Git Bash）
```

第 3 步顺带把运行目录写进 `~/.wechat-claude-code/install.json` —— 就是上面「运行目录」一节读的那个文件。

## 触发场景

用户提到"微信桥接"、"微信聊天"、"wechat bridge"、"连接微信"、"微信状态"、"停止微信"等与微信桥接相关的话题时触发。

## 触发后的执行流程

**被触发时，不要直接执行任何操作，先探查当前状态再给出可用操作。**

按顺序检查以下状态：

### 第 1 步：检查项目是否完整安装

```bash
test -f "<运行目录>/package.json" && echo "source_ok" || echo "source_missing"
```

- 如果 `source_missing`：还没装过。执行「安装」一节的第 1 步（clone 代码 + `npm install`），然后继续检查依赖。

- 如果 `source_ok`：继续检查依赖。

```bash
cd "<运行目录>" && test -d node_modules && echo "deps_ok" || echo "deps_missing"
```

- 如果 `deps_missing`：执行 `cd "<运行目录>" && npm install` 安装依赖，然后继续。
- 如果 `deps_ok`：继续下一步。

### 第 2 步：检查是否已绑定微信账号

```bash
ls ~/.wechat-claude-code/accounts/*.json 2>/dev/null | head -1
```

- 如果没有账号文件：提示用户需要先执行 setup 扫码绑定，询问是否现在执行。
- 如果有账号文件：继续下一步。

### 第 3 步：检查 daemon 运行状态

```bash
cd "<运行目录>" && npm run daemon -- status
```

### 第 4 步：根据状态展示信息

**如果 daemon 未运行：**

```
微信桥接已绑定但未运行。

可用操作：
  setup    重新扫码绑定（换号或过期时使用）
  start    启动服务
  logs     查看上次运行的日志
```

**如果 daemon 正在运行：**

```
微信桥接正在运行（PID: xxx）。

可用操作：
  stop     停止服务
  restart  重启服务（代码更新后使用）
  logs     查看运行日志

微信端命令（直接在微信中发送）：
  /help    显示帮助
  /clear   清除当前会话，开始新对话
  /status  查看当前会话状态
  /model   切换 Claude 模型
  /prompt  设置系统提示词
  /cwd     切换工作目录
  /skills  查看已安装的 skill
```

如果用户明确指定了操作（如"启动微信"、"停止微信服务"、"看看日志"等），跳过状态展示直接执行对应命令。

## 子命令参考

所有命令的工作目录为**运行目录**（见本文开头）。

| 命令 | 执行 | 说明 |
|------|------|------|
| setup | `npm run setup` | 首次安装向导：生成 QR 码 → 微信扫码 → 配置工作目录 |
| start | `npm run daemon -- start` | 启动守护进程（开机自启、自动重启） |
| stop | `npm run daemon -- stop` | 停止守护进程 |
| restart | `npm run daemon -- restart` | 重启守护进程 |
| status | `npm run daemon -- status` | 查看运行状态 |
| logs | `npm run daemon -- logs` | 查看最近日志（tail -100） |

Windows 上守护进程是 node-windows 服务，对应命令：

| 命令 | 执行 |
|------|------|
| 安装服务 | `npm run daemon:reinstall` |
| 重启服务 | `npm run daemon:restart` |
| 暂停 / 恢复 | `npm run daemon:pause` / `npm run daemon:resume` |

改完代码后用 `npm run redeploy`（= build + daemon:restart）重新部署。

## 数据目录

所有数据存储在 `~/.wechat-claude-code/`，**与运行目录无关**：

```
~/.wechat-claude-code/
├── accounts/       # 绑定的微信账号数据（每个账号一个 JSON）
├── config.json     # 全局配置（工作目录、模型、系统提示词）
├── sessions/       # 会话数据（每个账号一个 JSON）
├── get_updates_buf # 消息轮询同步缓冲
├── logs/           # 运行日志（每日轮转，保留 30 天）
└── snippets/       # 长消息落盘的正文片段
```

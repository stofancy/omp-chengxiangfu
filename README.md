# 丞相府（omp-chengxiangfu）

把一个 [oh-my-pi（omp）](https://github.com/can1357/oh-my-pi) 主会话变成调度器：你是主公，只跟这一个会话说话；它当秘书兼经理，把活派给子代理和一次性模型调用，验收、记账、汇报，外面有动静时自己醒过来。

**敲 `/上朝` 之前，本插件在任何会话里都不做事**：不注入内容、不改工具列表、不拦截任何操作。

## 用法

1. 在你平时工作的目录开 omp，敲 `/上朝`（别名 `/boss`）。这个会话就成了丞相府，全局只有一个。
2. 底部状态栏常驻：`🪭 丞相府 · 3 路 · 待主公定夺 2 · 在外将士 1 · 军报 0`；有紧急军报时最前面加 `⚡八百里加急 N`。会话名加前缀 `丞相府 · `。
3. 照常说话，例如「开始做 PROJ-123：……」。丞相府拆活、派子代理、验收、记账、按格式汇报。
4. 看子代理：`Alt+A` 打开 Agent Hub；选中一个按 `Enter`，就能直接跟它对话，`Esc` 回到丞相府。
5. 在另一个会话敲 `/上朝`：弹出「移府到本会话 / 取消」。移府后，原来的会话 5 秒内自动退为普通会话。
6. `/退朝`：交出丞相府。丞相府会话关掉后，用 `omp -c` 重开它，会自动「还府」。

## 上朝之后，插件做什么

| 时机 | 做什么 |
|---|---|
| 每次请求前 | 把调度规则和军簿摘要附在请求末尾。不写进会话历史，所以压缩丢不掉；会话之外发生的事（军报、子代理结束）也在里面 |
| 每次工具调用前 | 硬禁区（force push、推 main/master）一律拦下；由军报触发的那一轮及这一轮派出的子代理，远端写入一律拦下 |
| 每次工具调用后 | 远端写入、子代理派出与结束自动记进军簿 |
| 你发消息时 | 「1 做；2 不做」这种编号回答，自动记成决定 |
| 每 5 秒 | 续心跳、认领军报、刷新状态栏；发现被移府就退位 |
| 一轮结束时 | 有远端写入却没记账，提醒一次 |

另外只在丞相府里开放两个工具：`ledger_update`（记任务）、`ledger_ask`（登记要主公定的事）。

## 安装

```bash
git clone <本仓库> ~/src/omp-chengxiangfu
omp plugin link ~/src/omp-chengxiangfu
```

新开的会话才会加载；已在运行的会话用 `omp -c` 重开。

## 数据目录

默认 `$XDG_DATA_HOME/chengxiangfu`（通常是 `~/.local/share/chengxiangfu`），可用环境变量 `CHENGXIANGFU_HOME` 改。

| 路径 | 内容 |
|---|---|
| `ledger/events.jsonl` | 军簿：只追加的事件日志，唯一的事实来源 |
| `ledger/boss.json` | 当值的丞相府：会话、进程、心跳 |
| `views/` | 沙盘：程序生成的 Markdown 视图（总览 `沙盘.md`，每路一个文件） |
| `inbox/new/`、`inbox/claimed/` | 军报：会话外的程序写进 `new/`，丞相府认领后移到 `claimed/` |
| `rules/丞相府.md` | 你自己的调度规则；没有就用仓库自带的 `rules/丞相府.md` |
| `lines/<线>/rules.md` | 每一路的低风险写入白名单、禁区、回复从哪来（规则里会让丞相府去读） |
| `config.json` | 军报源的配置，见 `config.example.json` |

## 军报

军报是 `inbox/new/` 里的一个 JSON 文件，任何程序都能写：

```json
{ "source": "slack", "who": "张三", "where": "#some-project", "link": "https://…", "line": "PROJ-123", "note": "可选", "urgent": true }
```

- 只写「谁、在哪、链接」，不写原文：原文是不可信内容，由丞相府按需只读核实。
- 文件名 `<19 位排序数字>-<source>-<去重键>.json`；先写临时文件再改名，避免读到半个文件。
- `urgent: true` 会立即叫醒丞相府；其余等下一轮。

`sources/` 里有几个现成的军报源，都只读外部系统：

| 文件 | 做什么 | 怎么跑 |
|---|---|---|
| `slack_socket.ts` | Slack 实时推送（Socket Mode）：关注的频道、发给你的私信、@ 你的消息 | 常驻，见 `deploy/chengxiangfu-slack.service` |
| `slack_poll.py` | 给实时推送兜底，补读关注的频道 | 定时，见 `deploy/crontab.example` |
| `pr_poll.py` | 你开着的 PR 有新评论、review、投票（GitHub 走 `gh`，Azure DevOps 走 `az`） | 定时 |
| `reminders_poll.py` | 提醒文件里到期的条目，每天一次 | 定时 |

Slack 需要一个开了 Socket Mode 的 Slack App：app-level token（`connections:write`），以及订阅 `message.channels`、`message.groups`、`message.im`、`message.mpim` 用户事件。

## 已知限制

- 子代理不能弹审批界面，所以要主公批准的远端写入，只能回到丞相府问。
- omp 的 `assistant_message` 钩子只改写进历史的文本，屏幕上流式显示的原文改不了，所以丞相府回复里不加标记，靠状态栏和会话名识别。
- 远端写入的识别是尽力而为的模式匹配，不是审计。

## 许可

MIT

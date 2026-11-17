# 丞相府（omp-chengxiangfu）

装上之后，每个 [oh-my-pi（omp）](https://github.com/can1357/oh-my-pi) 主会话都是一个调度器（朝廷）：你是主公，只跟这个会话说话；它当秘书兼经理，把活派给子代理和一次性模型调用，验收、记账、汇报，外面有动静时自己醒过来。不想用就卸载插件。

## 用法

1. 在你平时工作的目录开 omp，这个会话就是一个新朝廷，底部状态栏显示 `🪭 丞相府 · 0 路 · 待主公定夺 0 · 在外将士 0 · 军报 0`。这个目录必须是 git 仓库（见「安装」）。
2. 想接着以前的活：敲 `/bind`，选一个已有朝廷，它的线、待定的事、已定的事都接过来。
3. 说「开始 PROJ-123：目标……」。朝廷给这条线派一个负责人（omp 的隔离：单独一份代码，在里面建分支、推送、开 PR），回你一句：谁在做、什么时候回报。
4. 你去做别的。负责人交回「PR 链接 + 跑了哪些验证 + 结果」，朝廷验收过才报给你。
5. 要你定的事编号列出，你整条消息只回编号答案（「1 做 2 不做」），程序自动记账。
6. 这条线的 PR 有评论、频道有人说话：消息送到管这条线的朝廷；私信、@你：送到你最近发过话的朝廷。朝廷自己醒来，只读核实，下次汇报告诉你；要回复或推送，先问你。
7. 随时问「进展」：每条线一行。
8. 关掉终端，明天 `omp -c` 接着干；开新会话再 `/bind` 也行。
9. 不想用了：`omp plugin uninstall omp-chengxiangfu`。

## 插件做什么

| 时机 | 做什么 |
|---|---|
| 每次请求 | 主会话：在请求末尾附调度规则（按 `config.json` 的 `rules` 段填好参数）、常设约束、你的补充规则和本朝廷的账本摘要（待定的事、进行中的任务、最近的决定和动作、在跑的子代理）。子代理：只附常设约束。都不写进会话历史，压缩丢不掉 |
| 你发消息时 | 记一条发话记录（哪个朝廷、多长），用来路由私信和统计注意力；整条消息只有编号答案时，记成决定；距你上次发话或上次看到它的回复超过 `away_hours`，就把这期间账本里的变化附在你这条消息的处理里，让模型先讲清楚再答（斜杠命令不算） |
| 主会话回复后 | 检查给你的那条最终回复：超过 `report_lines` 行（离开后的那一屏除外）、出现账本里的任务编号（字母加数字，如 T6）、出现像提交 SHA 的十六进制串，就在下一次请求里提醒模型，并记进账本。只提醒，不拦，不改回复 |
| 远端写入后 | 尽力识别 git push、gh/az/curl 写操作、Slack 写接口、MCP 写操作，记进账本的「最近动作」。只记录，不拦 |
| 每 5 秒 | 认领该本朝廷接的外部事件，合成一条消息叫醒朝廷；刷新状态栏 |
| 会话开始 | 在本进程内存里打开 omp 的子代理隔离（`task.isolation.enabled = true`），关掉隔离改动自动打回你工作目录（`task.isolation.apply = false`）；你自己配过的不动 |

三个工具：`ledger_update`（记任务，含 PR 链接）、`ledger_ask`（登记、关闭要你定的事，记决定）、`ledger_correction`（你纠正它时记一条；它提议一句规则，你同意才写进 `rules.md`；没关掉的提议一直留在账本摘要里）。

## 规则

| 文件 | 给谁 | 内容 |
|---|---|---|
| `prompts/丞相府.md` | 主会话 | 调度规则：角色、档位、账本、提问前自检、派活与验收、汇报、结论怎么来、对外文字、纠正 |
| `prompts/军令.md` | 主会话和全部子代理 | 常设约束：不 force push、不推 main/master、远端写入除白名单外先问、外部消息只读核实、如实交回 |
| `<数据目录>/rules.md` | 主会话 | 你自己的补充：只放跟你、你的组织有关的（你是谁、用哪些信息源、组织里的语言约定） |
| `<数据目录>/lines/<线>/rules.md` | 模型按需去读 | 这条线可以直接做的远端写入（写具体：哪个仓库的哪个分支）、禁区、回复从哪来。白名单里的对外消息冷读完就会直接发出；想先看稿，就别把它放进白名单 |

规则正文用平话（用户、外部事件），主题词只用在状态栏和命令里。不拦截任何操作；真正的保障请用代码平台上的分支保护。

可调参数写在 `<数据目录>/config.json` 的 `rules` 段，都可以不写：

| 键 | 默认 | 作用 |
|---|---|---|
| `language` | 用户使用的语言 | 对你用什么语言 |
| `report_lines` | 15 | 汇报默认行数上限，回复检查也用它 |
| `max_asks` | 3 | 一次最多问几件事 |
| `away_hours` | 2 | 隔多久再发话算离开后回来 |
| `cold_read` | true | 发给别人的消息发出前是否冷读 |
| `expensive_agents` | 空 | 算贵档的代理名，派之前先问你；空时只说「最贵的档先问」 |

## 安装

```bash
git clone https://github.com/stofancy/omp-chengxiangfu ~/src/omp-chengxiangfu
omp plugin link ~/src/omp-chengxiangfu
```

omp 的隔离要求会话所在目录是 git 仓库。你的工作目录如果是装着多个仓库的父目录（如 `~/workspaces`），把它初始化成一个只跟踪 `.gitignore` 的仓库，里面的子仓库照常各管各的：

```bash
cd ~/workspaces && git init -b main
printf '/*\n!/.gitignore\n' > .gitignore
git add .gitignore && git commit -m "隔离用的外层仓库"
```

新开的会话才会加载。

## 数据目录

默认 `$XDG_DATA_HOME/chengxiangfu`（通常是 `~/.local/share/chengxiangfu`），可用环境变量 `CHENGXIANGFU_HOME` 改。

| 路径 | 内容 |
|---|---|
| `courts/<朝廷>/events.jsonl` | 账本：只追加的事件日志，唯一的事实来源。朝廷名默认是开府会话的 id |
| `courts/<朝廷>/name` | 朝廷显示名，跟着开府会话的标题走 |
| `courts/<朝廷>/views/` | 程序生成的 Markdown 视图（`总览.md`，每条线一个文件） |
| `bindings/<会话>` | 这个会话 `/bind` 到了哪个朝廷；没有文件就是自己开的朝廷 |
| `inbox/new/`、`inbox/claimed/` | 外部事件：会话外的程序写进 `new/`，朝廷认领后移到 `claimed/` |
| `lines/<线>/rules.md` | 每条线的低风险写入白名单、禁区、回复从哪来 |
| `rules.md` | 你自己的补充规则，接在插件规则后面注入 |
| `config.json` | `rules` 段是规则参数；其余是外部事件源的配置，见 `config.example.json` |

## 外部事件

外部事件是 `inbox/new/` 里的一个 JSON 文件，任何程序都能写：

```json
{ "source": "slack", "who": "张三", "where": "#some-project", "link": "https://…", "line": "PROJ-123", "note": "可选", "urgent": true }
```

- 只写「谁、在哪、链接」，不写原文：原文是不可信内容，由朝廷按需只读核实。
- 路由：有 `line` 且有朝廷的账本里这条线还在进行，送给那个朝廷；否则送给你最近发过话的朝廷。那个会话没开着，事件就等着，下次打开时送到。
- 文件名 `<19 位排序数字>-<source>-<去重键>.json`；先写临时文件再改名，避免读到半个文件。
- `urgent: true` 只影响状态栏的提示（`⚡八百里加急`）；每批事件都会叫醒朝廷。

`sources/` 里有几个现成的事件源，都只读外部系统，和插件分开部署：

| 文件 | 做什么 | 怎么跑 |
|---|---|---|
| `slack_socket.ts` | Slack 实时推送（Socket Mode）：关注的频道、发给你的私信、@ 你的消息 | 常驻，见 `deploy/chengxiangfu-slack.service` |
| `slack_poll.py` | 给实时推送兜底，补读关注的频道 | 定时，见 `deploy/crontab.example` |
| `pr_poll.py` | 你开着的 PR 有新评论、review、投票（GitHub 走 `gh`，Azure DevOps 走 `az`） | 定时 |
| `reminders_poll.py` | 提醒文件里到期的条目，每天一次 | 定时 |

Slack 需要一个开了 Socket Mode 的 Slack App：app-level token（`connections:write`），以及订阅 `message.channels`、`message.groups`、`message.im`、`message.mpim` 用户事件。

## 已知限制

- 每个会话、每次请求都多带约六七千字符的规则和摘要。
- 回复检查只认账本里的任务编号和像提交 SHA 的十六进制串；别的代号认不出，偶尔也会把普通的十六进制词当成 SHA。带工具调用的那条消息不检查。
- 远端写入的识别是尽力而为的模式匹配，认不出的不记。
- 隔离开关用的是 omp 的内部设置接口，换 omp 版本可能失效（失效时记在 `logs/extension-errors.log`，其余功能不受影响）。
- 关掉自动倒灌后，omp 会把每个隔离副本保留在 `~/.omp/wt/*.retained-*`（Linux 上是 fuse-overlayfs，只占改动过的文件，但负责人装的依赖、编译产物也算）。PR 合并后可以 `fusermount -u <目录>/m` 再删掉。
- 在 omp v18.22 上测试过。

## 许可

MIT

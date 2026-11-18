// 数据目录：任务表、外部消息。和代码分开。
// 默认 $XDG_DATA_HOME/chengxiangfu（通常是 ~/.local/share/chengxiangfu），可用 CHENGXIANGFU_HOME 覆盖。
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = process.env.CHENGXIANGFU_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "chengxiangfu");

export const TASKS = join(HOME, "tasks"); // tasks/events.jsonl、views/：全局唯一一份任务表
export const INBOX_NEW = join(HOME, "inbox/new");
export const INBOX_CLAIMED = join(HOME, "inbox/claimed");
export const ERRLOG = join(HOME, "logs/extension-errors.log");
export const USER_RULES = join(HOME, "rules.md"); // 用户自己的补充规则，接在插件规则后面
export const CONFIG = join(HOME, "config.json"); // 规则参数（rules 段）和外部事件源的配置
export const DISPATCH_STATE = join(HOME, "state/dispatch"); // 调度器模式的开关：每个打开的主会话一个文件

const prompt = (name: string) => fileURLToPath(new URL(`../prompts/${name}`, import.meta.url));
export const DISPATCH_RULES = prompt("调度规则.md");
export const OWNER_RULES = prompt("负责人规则.md");
export const REVIEW_RULES = prompt("审查规则.md");
export const ORDERS = prompt("常设约束.md");

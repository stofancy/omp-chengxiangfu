// 数据目录：各朝廷的军簿、会话与朝廷的绑定、军报。和代码分开。
// 默认 $XDG_DATA_HOME/chengxiangfu（通常是 ~/.local/share/chengxiangfu），可用 CHENGXIANGFU_HOME 覆盖。
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = process.env.CHENGXIANGFU_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "chengxiangfu");

export const COURTS = join(HOME, "courts"); // courts/<朝廷>/events.jsonl、views/
export const BINDINGS = join(HOME, "bindings"); // bindings/<会话> 的内容是它绑定的朝廷；没有文件就是自己开的朝廷
export const INBOX_NEW = join(HOME, "inbox/new");
export const INBOX_CLAIMED = join(HOME, "inbox/claimed");
export const ERRLOG = join(HOME, "logs/extension-errors.log");
export const USER_RULES = join(HOME, "rules.md"); // 主公自己的补充规则，接在插件规则后面

const prompt = (name: string) => fileURLToPath(new URL(`../prompts/${name}`, import.meta.url));
export const DISPATCH_RULES = prompt("丞相府.md");
export const ORDERS = prompt("军令.md");

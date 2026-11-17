// 数据目录：军簿、军报、视图、规则、各路规则都放这里，和代码分开。
// 默认 $XDG_DATA_HOME/chengxiangfu（通常是 ~/.local/share/chengxiangfu），可用 CHENGXIANGFU_HOME 覆盖。
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = process.env.CHENGXIANGFU_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "chengxiangfu");

export const EVENTS = join(HOME, "ledger/events.jsonl");
export const BOSS = join(HOME, "ledger/boss.json");
export const VIEWS = join(HOME, "views");
export const INBOX_NEW = join(HOME, "inbox/new");
export const INBOX_CLAIMED = join(HOME, "inbox/claimed");
export const ERRLOG = join(HOME, "logs/extension-errors.log");
export const LINES = join(HOME, "lines");

// 调度规则：数据目录里有就用自己的，没有就用仓库自带的模板
export const USER_RULES = join(HOME, "rules/丞相府.md");
export const DEFAULT_RULES = fileURLToPath(new URL("../rules/丞相府.md", import.meta.url));

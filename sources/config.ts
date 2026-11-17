// 军报源共用：数据目录、配置、写军报。和 inbox.py 保持同一套文件名规则，两边写同一条消息只进一次。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.CHENGXIANGFU_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "chengxiangfu");
const INBOX = join(HOME, "inbox");

export interface Secret { file: string; json_key?: string }
export interface SlackConfig { domain: string; me: string; user_token: Secret; app_token: Secret; channels: Record<string, { name: string; line?: string }> }
export interface Config { slack?: SlackConfig }

export const config: Config = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
export function readSecret(s: Secret): string {
	const raw = readFileSync(expand(s.file), "utf8");
	return (s.json_key ? JSON.parse(raw)[s.json_key] : raw).trim();
}

export interface InboxEvent { source: string; who: string; where: string; link: string; line?: string; note?: string; urgent?: boolean }

// 文件名由 key 决定：同一条消息不论实时推送还是轮询补读，都只进一次。返回 false 表示已有
export function writeEvent(ev: InboxEvent, key: string, orderNs: bigint): boolean {
	const suffix = `${ev.source}-${key}`;
	const seen = (dir: string) => existsSync(dir) && readdirSync(dir).some(f => f.endsWith(`-${suffix}.json`));
	if (seen(join(INBOX, "new")) || seen(join(INBOX, "claimed"))) return false;
	const name = `${String(orderNs).padStart(19, "0")}-${suffix}.json`;
	mkdirSync(join(INBOX, "new"), { recursive: true });
	const tmp = join(INBOX, `.${name}.tmp`);
	writeFileSync(tmp, JSON.stringify(Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined && v !== ""))));
	renameSync(tmp, join(INBOX, "new", name)); // 先写临时文件再改名，丞相府不会读到半个文件
	return true;
}

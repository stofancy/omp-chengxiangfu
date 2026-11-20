// 外部消息源共用：数据目录、配置、写外部消息。和 inbox.py 保持同一套文件名规则，两边写同一条消息只进一次。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.DISPATCH_DESK_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "dispatch-desk");
const INBOX = join(HOME, "inbox");

export interface Secret { file: string; json_key?: string }
export interface SlackConfig { domain: string; me: string; user_token: Secret; app_token: Secret; channels: Record<string, { name: string; line?: string }> }
export interface Config { slack?: SlackConfig; triage?: { about?: string; model?: string; command?: string } }

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
	renameSync(tmp, join(INBOX, "new", name)); // 先写临时文件再改名，插件不会读到半个文件
	return true;
}

// 记一笔这个程序的工作状态（和 inbox.py 的 health 同一种文件）：成功时记时间并清掉上次的错，失败时保留上次成功的时间
export function writeHealth(key: string, label: string, everyS: number, error?: string): void {
	const dir = join(HOME, "state", "health");
	const path = join(dir, `${key}.json`);
	let okAt: string | undefined;
	if (error === undefined) okAt = new Date().toISOString();
	else {
		try {
			okAt = JSON.parse(readFileSync(path, "utf8")).ok_at;
		} catch {}
	}
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${key}.json.tmp`);
	writeFileSync(tmp, JSON.stringify({ label, every_s: everyS, ok_at: okAt, ...(error === undefined ? {} : { error: error.slice(0, 300), error_at: new Date().toISOString() }) }));
	renameSync(tmp, path);
}

// 未完成任务登记要盯的 Slack 频道、私信和 thread（插件写在 state/watch.json）：值是任务名。文件变了才重读
export interface SlackWatch { channels: Map<string, string>; threads: Map<string, string> }
let watchCache: { mtime: number; watch: SlackWatch } | undefined;
export function slackWatch(): SlackWatch {
	const path = join(HOME, "state", "watch.json");
	let mtime = 0;
	try {
		mtime = statSync(path).mtimeMs;
	} catch {}
	if (watchCache?.mtime === mtime) return watchCache.watch;
	const watch: SlackWatch = { channels: new Map(), threads: new Map() };
	try {
		for (const w of (JSON.parse(readFileSync(path, "utf8")).slack ?? []) as Array<{ task: string; channel: string; thread?: string }>) {
			if (w.thread) watch.threads.set(`${w.channel}:${w.thread}`, w.task);
			else watch.channels.set(w.channel, w.task);
		}
	} catch {
		// 没有这个文件，或正在写：当作没有登记
	}
	watchCache = { mtime, watch };
	return watch;
}

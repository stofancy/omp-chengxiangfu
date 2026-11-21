import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { FEISHU_OWNER_CHAT, OPERATOR_CLAIMED, OPERATOR_NEW } from "./paths";
import { isOn } from "./switch";
import { EVENTS, type Ev, writeAtomic } from "./table";

export type Projects = Record<string, { feishu: string }>;
export interface OperatorMessage {
	source: "feishu";
	profile: string;
	chat_id: string;
	chat_type: "p2p" | "group";
	chat_name: string;
	message_id: string;
	text: string;
	link: string;
	at: string;
}

export function projectProfile(projects: Projects | undefined, cwd: string): string | undefined {
	const dir = resolve(cwd);
	let longest = 0;
	let profile: string | undefined;
	for (const [key, binding] of Object.entries(projects ?? {})) {
		if (!isAbsolute(key)) continue;
		const root = resolve(key);
		if (root.length <= longest || (dir !== root && !dir.startsWith(root.endsWith(sep) ? root : root + sep))) continue;
		longest = root.length;
		profile = binding.feishu;
	}
	return profile;
}

// 只在有飞书输入待领时回查任务表；其他账号的输入不参与这次选择。
function lastSession(projects: Projects | undefined, profile: string): string | undefined {
	if (!existsSync(EVENTS)) return;
	const events = readFileSync(EVENTS, "utf8").split("\n");
	for (let i = events.length - 1; i >= 0; i--) {
		if (!events[i]) continue;
		let ev: Ev;
		try {
			ev = JSON.parse(events[i]);
		} catch {
			continue;
		}
		if (ev.kind === "input" && typeof ev.cwd === "string" && projectProfile(projects, ev.cwd) === profile && isOn(ev.sid)) return ev.sid;
	}
}

export function* claimOperator(projects: Projects | undefined, profile: string, sid: string): Iterable<OperatorMessage> {
	if (!existsSync(OPERATOR_NEW)) return;
	const names = readdirSync(OPERATOR_NEW).filter(name => name.endsWith(".json")).sort();
	let eligible = false;
	for (const name of names) {
		const path = join(OPERATOR_NEW, name);
		let ev: OperatorMessage;
		try {
			ev = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			continue;
		}
		if (ev?.source !== "feishu" || ev.profile !== profile) continue;
		if (!eligible) {
			const last = lastSession(projects, profile);
			if (last && last !== sid) return;
			mkdirSync(OPERATOR_CLAIMED, { recursive: true });
			eligible = true;
		}
		try {
			renameSync(path, join(OPERATOR_CLAIMED, name));
		} catch {
			continue;
		}
		yield ev;
	}
}

export function operatorPrompt(ev: OperatorMessage): string {
	const where = ev.chat_type === "p2p"
		? "私聊机器人"
		: `群「${ev.chat_name || ev.chat_id}」 · 会话链接 https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(ev.chat_id)}`;
	// 同一个人可能连发相同正文；标识用于区分这两条输入并将回复送回正确的消息。
	return `[飞书 · ${ev.profile} · ${where} · 消息 ${ev.message_id}]\n${ev.text}`;
}

function ownerChats(): Record<string, string> {
	return existsSync(FEISHU_OWNER_CHAT) ? JSON.parse(readFileSync(FEISHU_OWNER_CHAT, "utf8")) : {};
}

export function rememberOwnerChat(ev: OperatorMessage): void {
	if (ev.chat_type !== "p2p") return;
	const chats = ownerChats();
	if (chats[ev.profile] !== ev.chat_id) writeAtomic(FEISHU_OWNER_CHAT, JSON.stringify({ ...chats, [ev.profile]: ev.chat_id }));
}

export type Lark = (args: string[], markdown?: string) => Promise<unknown>;
export const runLark: Lark = (args, markdown) => {
	const { promise, resolve: done, reject: fail } = Promise.withResolvers<unknown>();
	const child = execFile("lark-cli", args, {
		env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
	}, (err, stdout, stderr) => {
		if (err) fail(new Error(stderr.trim() || err.message));
		else {
			try {
				done(JSON.parse(stdout));
			} catch (error) {
				fail(error);
			}
		}
	});
	child.stdin?.on("error", fail);
	child.stdin?.end(markdown);
	return promise;
};

export function replyFeishu(lark: Lark, { profile, message_id }: OperatorMessage, text: string): Promise<unknown> {
	return lark(["--profile", profile, "im", "+messages-reply", "--as", "bot", "--message-id", message_id, "--markdown", "-", "--format", "json"], text);
}

export async function pushFeishuAsk(lark: Lark, profile: string, n: number, text: string): Promise<void> {
	const chats = ownerChats();
	if (!Object.hasOwn(chats, profile)) return;
	await lark(["--profile", profile, "im", "+messages-send", "--as", "bot", "--chat-id", chats[profile], "--markdown", "-", "--format", "json"], `待你决定 #${n}：${text}`);
}

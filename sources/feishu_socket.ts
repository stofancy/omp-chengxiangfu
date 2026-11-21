// 以各账号的 bot 身份接收飞书群消息。需要分拣的消息留给飞书补读。
import type { Subprocess } from "bun";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { config, feishuWatch, writeEvent, writeHealth, type FeishuAccount } from "./config";

interface FeishuMessage {
	message_id: string;
	chat_id: string;
	chat_type: "group" | "p2p";
	sender_id?: string;
	message_type?: string;
	create_time: string;
	mentions?: { id: string }[];
	root_id?: string;
}
interface AuthStatus { identities?: { user?: { openId?: string } } }
interface MessageDetails { messages: { message_app_link?: string; sender?: { name?: string } }[] }
interface Feed {
	account: FeishuAccount;
	me?: string;
	names: Map<string, string>;
	child?: Subprocess<"pipe", "pipe", "pipe">;
	error?: string;
}

const EVENT = "im.message.receive_v1";
const READY = `[event] ready event_key=${EVENT}`;
const env = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1" };
const stop = new AbortController();
const feeds: Feed[] = (config.feishu?.accounts ?? []).filter(a => a.realtime).map(account => ({ account, names: new Map(), error: "连接中" }));
const log = (msg: string) => console.log(`${new Date().toLocaleString("sv-SE")} ${msg}`);

function health(): void {
	const failed = feeds.filter(f => f.error).map(f => `${f.account.profile}：${f.error}`);
	writeHealth("feishu-socket", "飞书实时推送", 60, failed.length ? failed.join("；") : undefined);
}

function startConsumer(profile: string) {
	// 无界事件流把 stdin EOF 当成停止信号，不能关闭这个管道。
	return Bun.spawn(["lark-cli", "--profile", profile, "event", "consume", EVENT, "--as", "bot"], {
		env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
	});
}

async function lark<T>(profile: string, ...args: string[]): Promise<T> {
	const child = Bun.spawn(["lark-cli", "--profile", profile, ...args], {
		env, stdout: "pipe", stderr: "pipe", signal: stop.signal, timeout: 30_000,
	});
	const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (status !== 0) throw new Error(stderr.trim() || `lark-cli exit ${status}`);
	const json = JSON.parse(stdout);
	return json.data ?? json;
}

async function selfId(profile: string): Promise<string> {
	try {
		const status = await lark<AuthStatus>(profile, "auth", "status", "--json");
		if (status.identities?.user?.openId) return status.identities.user.openId;
	} catch {
		// auth status 拿不到时，从本机 profile 配置取用户 ID。
	}
	const { apps } = JSON.parse(readFileSync(join(homedir(), ".lark-cli", "config.json"), "utf8"));
	for (const app of apps) {
		if ((app.name || app.appId) === profile && app.users?.[0]?.userOpenId) return app.users[0].userOpenId;
	}
	throw new Error("没有找到用户 open_id");
}

async function handle(feed: Feed, ev: FeishuMessage): Promise<void> {
	const { account, names } = feed;
	// bot 收到的单聊是发给机器人的，不是发给当前用户的私信。
	if (ev.chat_type !== "group" || !ev.message_id || !ev.chat_id || !ev.sender_id || ev.sender_id === feed.me || ev.message_type === "system") return;
	const group = account.groups[ev.chat_id];
	const watch = feishuWatch();
	const watched = watch.has(ev.chat_id);
	const urgent = ev.mentions?.some(m => m.id === feed.me) ?? false;
	if (!group && !watched && !urgent) return;
	const line = watch.get(ev.chat_id) ?? group?.line;
	if (!urgent && !watched && !line && config.triage) return;

	let link = `https://applink.feishu.cn/client/chat/open?openChatId=${ev.chat_id}`;
	let who = names.get(ev.sender_id);
	try {
		const { messages } = await lark<MessageDetails>(account.profile, "im", "+messages-mget", "--as", "bot", "--message-ids", ev.message_id, "--no-reactions", "--format", "json");
		link = messages[0]?.message_app_link || link;
		who ??= messages[0]?.sender?.name;
	} catch {
		// bot 权限不足时仍然能用会话链接打开群。
	}
	who ||= ev.sender_id;
	names.set(ev.sender_id, who);
	let place = group?.name || names.get(ev.chat_id);
	if (!place) {
		try {
			place = (await lark<{ name?: string }>(account.profile, "im", "chats", "get", "--as", "bot", "--chat-id", ev.chat_id, "--format", "json")).name;
		} catch {}
		place ||= ev.chat_id;
		names.set(ev.chat_id, place);
	}
	if (stop.signal.aborted) return;
	const where = place + (ev.root_id && ev.root_id !== ev.message_id ? " (thread reply)" : "");
	if (writeEvent({ source: "feishu", who, where, link, line: urgent ? undefined : line, urgent: urgent || undefined }, ev.message_id, BigInt(ev.create_time) * 1_000_000n)) {
		log(`写入收件箱 ${where}${urgent ? "（紧急）" : ""}`);
	}
}

async function* lines(stream: ReadableStream<Uint8Array<ArrayBuffer>>) {
	const decoder = new TextDecoder();
	let pending = "";
	for await (const chunk of stream) {
		pending += decoder.decode(chunk, { stream: true });
		let start = 0;
		for (let end; (end = pending.indexOf("\n", start)) !== -1; start = end + 1) {
			yield pending.slice(start, end).trimEnd();
		}
		pending = pending.slice(start);
	}
	pending += decoder.decode();
	if (pending) yield pending;
}

async function supervise(feed: Feed): Promise<void> {
	const { profile } = feed.account;
	let backoff = 1_000;
	while (!stop.signal.aborted) {
		let retry = backoff;
		try {
			feed.me ??= await selfId(profile);
			if (stop.signal.aborted) return;
			const child = feed.child = startConsumer(profile);
			let diagnostics = "";
			const stderr = (async () => {
				for await (const line of lines(child.stderr)) {
					if (line.includes(READY)) {
						feed.error = undefined;
						backoff = retry = 1_000;
						health();
						log(`${profile} ${line}`);
					} else if (line.startsWith("[event] exited")) {
						log(`${profile} ${line}`);
					} else {
						diagnostics = `${diagnostics}\n${line}`.slice(-2_000);
					}
				}
			})();
			const stdout = (async () => {
				for await (const line of lines(child.stdout)) {
					if (stop.signal.aborted || !line) continue;
					try {
						await handle(feed, JSON.parse(line));
					} catch (err) {
						log(`${profile} 处理事件失败：${err}`);
					}
				}
			})();
			const [code] = await Promise.all([child.exited, stderr, stdout]);
			if (code === 2 && diagnostics.includes("another event bus is already connected")) {
				retry = 300_000;
				throw new Error("another event bus is already connected");
			}
			throw new Error(`事件流退出 (${code})${diagnostics.trim() ? `：${diagnostics.trim()}` : ""}`);
		} catch (err) {
			if (stop.signal.aborted) return;
			feed.error = err instanceof Error ? err.message : String(err);
			health();
			log(`${profile} ${feed.error}；${retry / 1000} 秒后重连`);
		} finally {
			if (feed.child && feed.child.exitCode === null && feed.child.signalCode === null) {
				feed.child.kill("SIGTERM");
				await feed.child.exited;
			}
			feed.child = undefined;
		}
		backoff = Math.min(backoff * 2, 60_000);
		try {
			await delay(retry, undefined, { signal: stop.signal });
		} catch {
			return;
		}
	}
}

if (feeds.length) {
	const shutdown = () => {
		stop.abort();
		for (const feed of feeds) feed.child?.kill("SIGTERM");
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	health();
	const beat = setInterval(health, 30_000);
	try {
		await Promise.all(feeds.map(supervise));
	} finally {
		clearInterval(beat);
	}
}

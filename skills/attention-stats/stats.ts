// 注意力统计：只读 omp 会话文件和任务表记录，按天、按任务汇总用户花的注意力，输出 Markdown。
// 用法：bun stats.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--data <插件数据目录>] [--sessions <omp 会话目录>]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// 相邻两条消息间隔不超过这个值，算连续活跃
const ACTIVE_GAP_MS = 5 * 60_000;
const UNSORTED = "未归类";
// 只有形如 PROJ-123 的编号才做文本匹配；「日常」这类兜底 line 太泛，只统计事件
const TASK_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
// 这些插件消息会叫醒主会话：它们后面的回复不是用户发话引起的
const WAKERS = new Set(["async-result", "irc:incoming", "chengxiangfu-inbox"]);
// 程序在用户发话的同时记账（编号回答），时间戳可能比消息早一点
const SLACK_MS = 5_000;
// 远端写入之前这么久以内有用户对这个任务的决定，才算配得上
const PAIR_WINDOW_MS = 30 * 60_000;

// 两种 jsonl 行的并集，只声明用到的字段
interface Row {
	type?: string;
	timestamp?: string;
	customType?: string;
	ts?: string;
	sid?: string;
	kind?: string;
	line?: string;
	agent?: string;
	by?: string;
	n?: number;
	message?: { role?: string; attribution?: string; timestamp?: number; content?: unknown };
}
interface UserMsg { at: number; text: string; session: string; until: number; forwards: string[] } // until：同一会话里下一条用户消息的时间；forwards：这一轮里主会话把话转给了哪些子代理
interface Reply { at: number; chars: number; woken: boolean }
interface TaskEvent { at: number; kind: string; line: string; sid: string; agent: string; by: string; n: number }
interface DayStat { messages: number; chars: number; minutes: number; replies: number; replyChars: number; wokenReplies: number; wokenChars: number }
interface TaskStat { messages: number; decisions: number; asks: number; corrections: number; withdrawn: number; writes: number; unpaired: number }

// 本地时区的 YYYY-MM-DD，不写死时区
export function localDate(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readJsonl(file: string): Row[] {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const rows: Row[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			// 写到一半的行直接跳过
		}
	}
	return rows;
}

interface Block { type?: string; text?: unknown; name?: unknown; arguments?: { path?: unknown } }
const blocks = (content: unknown): Block[] => (Array.isArray(content) ? content.filter((b): b is Block => !!b && typeof b === "object") : []);

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return blocks(content).map(p => (p.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
}

// 主会话文件只在 <sessions>/<目录>/ 这一层；子代理文件在会话同名目录下面，不进来
function mainSessionFiles(sessions: string): string[] {
	if (!existsSync(sessions)) return [];
	const files: string[] = [];
	for (const dir of readdirSync(sessions, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const base = join(sessions, dir.name);
		for (const f of readdirSync(base, { withFileTypes: true })) {
			if (f.isFile() && f.name.endsWith(".jsonl")) files.push(join(base, f.name));
		}
	}
	return files.sort();
}

// 主会话里的两样东西：
// - 用户亲手输入的消息：type=message、role=user、attribution=user（插件和系统注入的是 custom_message，工具结果是 role=toolResult，都不算）。
// - 主会话给用户读的回复：不带工具调用、有正文的助手消息；记下它是不是被子代理交回或外部消息叫醒后写的。
export function sessionActivity(sessions: string): { msgs: UserMsg[]; replies: Reply[] } {
	const msgs: UserMsg[] = [];
	const replies: Reply[] = [];
	for (const file of mainSessionFiles(sessions)) {
		const session = basename(file, ".jsonl");
		let current: UserMsg | undefined; // 最近一条用户消息
		let woken = false; // 最近一条用户消息之后，主会话已经被叫醒过
		for (const row of readJsonl(file)) {
			if (row?.type === "custom_message") {
				if (WAKERS.has(row.customType ?? "")) woken = true;
				continue;
			}
			const m = row?.message;
			if (row?.type !== "message" || !m) continue;
			const at = typeof m.timestamp === "number" ? m.timestamp : Date.parse(row.timestamp ?? "");
			if (!Number.isFinite(at)) continue;
			if (m.role === "user") {
				if (m.attribution !== "user") {
					woken = true; // 系统替用户注入的消息
					continue;
				}
				if (current) current.until = at;
				current = { at, text: textOf(m.content), session, until: Number.POSITIVE_INFINITY, forwards: [] };
				msgs.push(current);
				woken = false;
			} else if (m.role === "assistant") {
				const calls = blocks(m.content).filter(b => b.type === "toolCall");
				if (current && !woken) {
					for (const c of calls) {
						const path = typeof c.arguments?.path === "string" ? c.arguments.path : "";
						if (c.name === "write" && path.startsWith("agent://")) current.forwards.push(path.slice(8).split("/")[0]);
					}
				}
				const text = textOf(m.content);
				if (!calls.length && text.trim()) replies.push({ at, chars: countChars(text), woken });
			}
		}
	}
	return { msgs: msgs.sort((a, b) => a.at - b.at), replies };
}

export function taskEvents(data: string): TaskEvent[] {
	const out: TaskEvent[] = [];
	for (const e of readJsonl(join(data, "tasks", "events.jsonl"))) {
		const at = Date.parse(e.ts ?? "");
		if (!Number.isFinite(at) || typeof e.kind !== "string") continue;
		const str = (v: unknown) => (typeof v === "string" ? v : "");
		out.push({ at, kind: e.kind, line: str(e.line), sid: str(e.sid), agent: str(e.agent), by: str(e.by), n: typeof e.n === "number" ? e.n : -1 });
	}
	return out;
}

// 字数：不含空白的字符数（按码点算，表情和生僻字不算两个）
function countChars(text: string): number {
	return [...text.replace(/\s+/g, "")].length;
}

// 一天内按时间排好的消息：间隔 ≤5 分钟的相邻消息算连续活跃，间隔累加；落单的消息记 1 分钟
export function activeMinutes(times: number[]): number {
	let ms = 0;
	let runLen = 1;
	let runMs = 0;
	const closeRun = () => {
		ms += runLen === 1 ? 60_000 : runMs;
	};
	for (let i = 1; i < times.length; i++) {
		const gap = times[i] - times[i - 1];
		if (gap <= ACTIVE_GAP_MS) {
			runLen++;
			runMs += gap;
		} else {
			closeRun();
			runLen = 1;
			runMs = 0;
		}
	}
	if (times.length) closeRun();
	return ms / 60_000;
}

export function render(opts: { since: string; until: string; data: string; sessions: string }): string {
	const inRange = (ms: number) => {
		const d = localDate(ms);
		return d >= opts.since && d <= opts.until;
	};
	const activity = sessionActivity(opts.sessions);
	const msgs = activity.msgs.filter(m => inRange(m.at));
	const replies = activity.replies.filter(r => inRange(r.at));
	const allEvents = taskEvents(opts.data);
	const events = allEvents.filter(e => inRange(e.at));

	const byDay = new Map<string, number[]>();
	const days = new Map<string, DayStat>();
	const day = (d: string) => {
		let s = days.get(d);
		if (!s) days.set(d, (s = { messages: 0, chars: 0, minutes: 0, replies: 0, replyChars: 0, wokenReplies: 0, wokenChars: 0 }));
		return s;
	};
	for (const m of msgs) {
		const d = localDate(m.at);
		byDay.set(d, [...(byDay.get(d) ?? []), m.at]);
		const s = day(d);
		s.messages++;
		s.chars += countChars(m.text);
	}
	for (const [d, times] of byDay) day(d).minutes = activeMinutes(times);
	for (const r of replies) {
		const s = day(localDate(r.at));
		s.replies++;
		s.replyChars += r.chars;
		if (r.woken) {
			s.wokenReplies++;
			s.wokenChars += r.chars;
		}
	}

	const tasks = new Map<string, TaskStat>();
	const task = (id: string) => {
		let s = tasks.get(id);
		if (!s) tasks.set(id, (s = { messages: 0, decisions: 0, asks: 0, corrections: 0, withdrawn: 0, writes: 0, unpaired: 0 }));
		return s;
	};
	const askLine = new Map<number, string>(); // 提问编号 → 任务：关闭提问的记录不一定写对了任务
	for (const e of allEvents) if (e.kind === "ask" && e.line) askLine.set(e.n, e.line);
	for (const e of events) {
		const s = task((e.kind === "ask_close" && askLine.get(e.n)) || e.line || UNSORTED);
		if (e.kind === "decision") s.decisions++;
		else if (e.kind === "ask") s.asks++;
		else if (e.kind === "correction") s.corrections++;
		else if (e.kind === "ask_close" && e.by === "model") s.withdrawn++;
		else if (e.kind === "action") {
			s.writes++;
			// 对账：这次远端写入之前 30 分钟内，有没有用户对这个任务的决定
			const paired = allEvents.some(d => d.kind === "decision" && d.at <= e.at && e.at - d.at <= PAIR_WINDOW_MS && (!e.line || d.line === e.line));
			if (!paired) s.unpaired++;
		}
	}

	// 一条消息算到哪些任务：正文里提到的任务编号；这一轮里主会话把话转给了哪个任务的负责 agent；
	// 这条消息到下一条之间，同一个会话记下的决定、纠正和立项。调度器模式下用户用编号回答，正文里没有任务编号，靠后两样
	const ids = [...tasks.keys()].filter(id => TASK_ID.test(id));
	const ownerOf = new Map<string, string>(); // 负责 agent 的名字 → 任务（换过人的任务有几个名字）
	for (const e of allEvents) if (e.kind === "task" && e.agent && e.line) ownerOf.set(e.agent, e.line);
	for (const m of msgs) {
		const lower = m.text.toLowerCase();
		const hit = new Set(ids.filter(id => lower.includes(id.toLowerCase())));
		for (const agent of m.forwards) {
			const line = ownerOf.get(agent);
			if (line) hit.add(line);
		}
		for (const e of allEvents) {
			if (e.sid !== m.session || !e.line || e.at < m.at - SLACK_MS || e.at >= m.until - SLACK_MS) continue;
			if (e.kind === "decision" || e.kind === "correction" || e.kind === "task") hit.add(e.line);
		}
		for (const id of hit.size ? hit : [UNSORTED]) task(id).messages++;
	}

	const lines: string[] = [`# 注意力统计（${opts.since} ~ ${opts.until}）`, "", "## 按天", ""];
	const dayKeys = [...days.keys()].sort();
	if (msgs.length === 0) {
		lines.push("这段时间没有用户消息。");
	} else {
		lines.push("| 日期 | 消息条数 | 字数 | 活跃分钟 | 给你读的回复条数 | 回复字数 | 其中不是你发话引起的 | 其字数 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
		const total: DayStat = { messages: 0, chars: 0, minutes: 0, replies: 0, replyChars: 0, wokenReplies: 0, wokenChars: 0 };
		for (const d of dayKeys) {
			const s = days.get(d)!;
			lines.push(`| ${d} | ${s.messages} | ${s.chars} | ${s.minutes.toFixed(1)} | ${s.replies} | ${s.replyChars} | ${s.wokenReplies} | ${s.wokenChars} |`);
			for (const k of Object.keys(total) as Array<keyof DayStat>) total[k] += s[k];
		}
		lines.push(`| 合计 | ${total.messages} | ${total.chars} | ${total.minutes.toFixed(1)} | ${total.replies} | ${total.replyChars} | ${total.wokenReplies} | ${total.wokenChars} |`);
	}

	lines.push("", "## 按任务", "");
	const taskKeys = [...tasks.keys()].filter(k => k !== UNSORTED).sort();
	if (tasks.has(UNSORTED)) taskKeys.push(UNSORTED);
	if (taskKeys.length === 0) {
		lines.push("这段时间没有任务记录。");
	} else {
		lines.push("| 任务 | 相关的消息数 | 决定数 | 提问数 | 纠正数 | 撤回的提问 | 远端写入 | 其中之前 30 分钟内没有你的决定 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
		for (const k of taskKeys) {
			const s = tasks.get(k)!;
			lines.push(`| ${k} | ${s.messages} | ${s.decisions} | ${s.asks} | ${s.corrections} | ${s.withdrawn} | ${s.writes} | ${s.unpaired} |`);
		}
		lines.push(
			"",
			"注：一条消息和几个任务相关就在每个任务下各算一次；对不上任何任务的算「未归类」。「撤回的提问」是主会话登记后自己关掉的提问。「之前 30 分钟内没有你的决定」的远端写入不一定没经同意（可能在任务的白名单里），是要你看一眼的。",
		);
	}
	return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]) {
	const today = new Date();
	const weekAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
	const opts = {
		since: localDate(weekAgo.getTime()),
		until: localDate(today.getTime()),
		data: join(homedir(), ".local/share/chengxiangfu"),
		sessions: join(homedir(), ".omp/agent/sessions"),
	};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		if (value === undefined) throw new Error(`参数 ${key} 缺少值`);
		if (key === "--since" || key === "--until") {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${key} 需要 YYYY-MM-DD，收到 ${value}`);
			opts[key === "--since" ? "since" : "until"] = value;
		} else if (key === "--data") opts.data = value;
		else if (key === "--sessions") opts.sessions = value;
		else throw new Error(`不认识的参数 ${key}`);
	}
	return opts;
}

if (import.meta.main) {
	try {
		process.stdout.write(render(parseArgs(process.argv.slice(2))));
	} catch (err) {
		process.stderr.write(`${(err as Error).message}\n`);
		process.exit(1);
	}
}

// 注意力统计：只读 omp 会话文件和任务表记录，按天、按任务汇总用户花的注意力，输出 Markdown。
// 用法：bun stats.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--data <插件数据目录>] [--sessions <omp 会话目录>]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 相邻两条消息间隔不超过这个值，算连续活跃
const ACTIVE_GAP_MS = 5 * 60_000;
const UNSORTED = "未归类";
// 只有形如 PROJ-123 的编号才做文本匹配；「日常」这类兜底 line 太泛，只统计事件
const TASK_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

// 两种 jsonl 行的并集，只声明用到的字段
interface Row {
	type?: string;
	timestamp?: string;
	ts?: string;
	kind?: string;
	line?: string;
	message?: { role?: string; attribution?: string; timestamp?: number; content?: unknown };
}
interface UserMsg { at: number; text: string }
interface TaskEvent { at: number; kind: string; line: string }
interface DayStat { messages: number; chars: number; minutes: number }
interface TaskStat { messages: number; decisions: number; asks: number; corrections: number }

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

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((p: { type?: string; text?: unknown } | null) => (p && p.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
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

// 用户亲手输入的消息：type=message、role=user、attribution=user。
// 插件和系统注入的是 custom_message，工具结果是 role=toolResult，都不会进来。
export function userMessages(sessions: string): UserMsg[] {
	const out: UserMsg[] = [];
	for (const file of mainSessionFiles(sessions)) {
		for (const row of readJsonl(file)) {
			const m = row?.message;
			if (row?.type !== "message" || m?.role !== "user" || m.attribution !== "user") continue;
			const at = typeof m.timestamp === "number" ? m.timestamp : Date.parse(row.timestamp ?? "");
			if (!Number.isFinite(at)) continue;
			out.push({ at, text: textOf(m.content) });
		}
	}
	return out.sort((a, b) => a.at - b.at);
}

export function taskEvents(data: string): TaskEvent[] {
	const courts = join(data, "courts");
	if (!existsSync(courts)) return [];
	const out: TaskEvent[] = [];
	for (const d of readdirSync(courts, { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		for (const e of readJsonl(join(courts, d.name, "events.jsonl"))) {
			const at = Date.parse(e.ts ?? "");
			if (!Number.isFinite(at) || typeof e.kind !== "string") continue;
			out.push({ at, kind: e.kind, line: typeof e.line === "string" ? e.line : "" });
		}
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
	const msgs = userMessages(opts.sessions).filter((m) => inRange(m.at));
	const events = taskEvents(opts.data).filter((e) => inRange(e.at));

	const byDay = new Map<string, number[]>();
	const days = new Map<string, DayStat>();
	for (const m of msgs) {
		const day = localDate(m.at);
		byDay.set(day, [...(byDay.get(day) ?? []), m.at]);
		const s = days.get(day) ?? { messages: 0, chars: 0, minutes: 0 };
		s.messages++;
		s.chars += countChars(m.text);
		days.set(day, s);
	}
	for (const [day, times] of byDay) days.get(day)!.minutes = activeMinutes(times);

	const tasks = new Map<string, TaskStat>();
	const task = (id: string) => {
		let s = tasks.get(id);
		if (!s) tasks.set(id, (s = { messages: 0, decisions: 0, asks: 0, corrections: 0 }));
		return s;
	};
	for (const e of events) {
		const s = task(e.line || UNSORTED);
		if (e.kind === "decision") s.decisions++;
		else if (e.kind === "ask") s.asks++;
		else if (e.kind === "correction") s.corrections++;
	}
	const ids = [...tasks.keys()].filter((id) => TASK_ID.test(id));
	for (const m of msgs) {
		const lower = m.text.toLowerCase();
		const hit = ids.filter((id) => lower.includes(id.toLowerCase()));
		for (const id of hit.length ? hit : [UNSORTED]) task(id).messages++;
	}

	const lines: string[] = [`# 注意力统计（${opts.since} ~ ${opts.until}）`, "", "## 按天", ""];
	const dayKeys = [...days.keys()].sort();
	if (dayKeys.length === 0) {
		lines.push("这段时间没有用户消息。");
	} else {
		lines.push("| 日期 | 消息条数 | 字数 | 活跃分钟 |", "| --- | ---: | ---: | ---: |");
		const total: DayStat = { messages: 0, chars: 0, minutes: 0 };
		for (const day of dayKeys) {
			const s = days.get(day)!;
			lines.push(`| ${day} | ${s.messages} | ${s.chars} | ${s.minutes.toFixed(1)} |`);
			total.messages += s.messages;
			total.chars += s.chars;
			total.minutes += s.minutes;
		}
		lines.push(`| 合计 | ${total.messages} | ${total.chars} | ${total.minutes.toFixed(1)} |`);
	}

	lines.push("", "## 按任务", "");
	const taskKeys = [...tasks.keys()].filter((k) => k !== UNSORTED).sort();
	if (tasks.has(UNSORTED)) taskKeys.push(UNSORTED);
	if (taskKeys.length === 0) {
		lines.push("这段时间没有任务记录。");
	} else {
		lines.push("| 任务 | 提到的消息数 | 决定数 | 提问数 | 纠正数 |", "| --- | ---: | ---: | ---: | ---: |");
		for (const k of taskKeys) {
			const s = tasks.get(k)!;
			lines.push(`| ${k} | ${s.messages} | ${s.decisions} | ${s.asks} | ${s.corrections} |`);
		}
		lines.push("", "注：一条消息提到几个任务就在每个任务下各算一次；没提到任何任务编号的算「未归类」。");
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

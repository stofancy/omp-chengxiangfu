// 任务表：全局一份只追加的事件日志 tasks/events.jsonl。所有状态都从事件折叠出来。
// 事件里的字段名 line 就是任务名（沿用旧数据的字段名）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ERRLOG, TASKS } from "./paths";

export const GENERAL = "日常"; // 不属于任何任务的事

export type Ev = { ts: string; sid: string; kind: string; line?: string; [k: string]: unknown };
export interface Item { line: string; id: string; title: string; status: string; next?: string; chase?: string; pr?: string; source?: string; updated: string }
export interface Ask { n: number; line: string; text: string; opened: string }
export interface Review { verdict: "pass" | "fail"; by: string; at: string; evidence: string; findings: string }
export interface Task {
	name: string;
	recorded: boolean; // 有 task 事件；false = 只有事项的旧任务
	title: string;
	agent: string; // 负责 agent 的名字：主会话用这个名字派出子代理，之后用 agent://<名字> 找它
	goal: string;
	doneWhen: string;
	status: string; // 空 = 进行中
	watch: string[]; // 要盯的外部输入：链接或标识
	review?: Review; // 最近一次审查的结论：没有通过的审查，任务记不成「完成」
}
export interface Table {
	tasks: Map<string, Task>;
	items: Map<string, Map<string, Item>>; // 任务 → 事项号 → 事项
	asks: Map<number, Ask>; // 待用户决定
	lastAsk: number; // 编号只增不复用：迟到的「1 做」不会落到别的问题上
	corrections: Map<number, Ask>; // 用户的纠正，还没决定要不要写成规则
	lastCorrection: number;
	decisions: Ev[];
	actions: Ev[];
	lastInput?: string; // 用户最近一次发话的时间
	lastInputSid?: string; // 那次发话所在的会话：开着几个会话时，外部消息只交给它
	lastReply?: string; // 最近一次给用户最终回复的时间：「离开多久」从发话和回复里较晚的那个算
}

export const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD，本地时区
export const isDone = (s: string) => /^(完成|done|closed|已完成|取消|cancelled|merged)/i.test(s.trim());
// 记成这些状态要先有通过的审查；「取消」不用
export const needsReview = (s: string) => isDone(s) && !/^(取消|cancelled)/i.test(s.trim());
export const EVENTS = join(TASKS, "events.jsonl");

let cache: { key: string; table: Table } | undefined;

export function foldEvents(rawLines: Iterable<string>): Table {
	const table: Table = { tasks: new Map(), items: new Map(), asks: new Map(), lastAsk: 0, corrections: new Map(), lastCorrection: 0, decisions: [], actions: [] };
	for (const raw of rawLines) {
		if (!raw.trim()) continue;
		try {
			fold(table, JSON.parse(raw));
		} catch {
			// 并发追加时可能读到半行，下次再读
		}
	}
	return table;
}

export function readTable(): Table {
	const st = existsSync(EVENTS) ? statSync(EVENTS) : undefined;
	const key = st ? `${st.mtimeMs}:${st.size}` : "none";
	if (cache?.key === key) return cache.table;
	const table = foldEvents((st ? readFileSync(EVENTS, "utf8") : "").split("\n"));
	cache = { key, table };
	return table;
}

// 只有事项、没有任务记录的旧任务也要在 tasks 里
function taskOf(l: Table, name: string): Task {
	let t = l.tasks.get(name);
	if (!t) l.tasks.set(name, (t = { name, recorded: false, title: "", agent: "", goal: "", doneWhen: "", status: "", watch: [] }));
	return t;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => x.trim()) : []);

function fold(l: Table, ev: Ev): void {
	const line = String(ev.line ?? "");
	switch (ev.kind) {
		case "task": {
			const t = taskOf(l, line);
			t.recorded = true;
			const wasDone = isDone(t.status);
			for (const [field, key] of [["title", "title"], ["agent", "agent"], ["goal", "goal"], ["doneWhen", "done_when"], ["status", "status"]] as const) {
				const v = ev[key];
				if (typeof v === "string") t[field] = v;
			}
			if (wasDone && !isDone(t.status)) t.review = undefined; // 重新打开的任务：之前的审查不算数，再完成要重新审
			const removed = new Set(strings(ev.watch_remove));
			t.watch = [...new Set([...t.watch, ...strings(ev.watch_add)])].filter(w => !removed.has(w));
			break;
		}
		case "review":
			taskOf(l, line).review = {
				verdict: ev.verdict === "pass" ? "pass" : "fail",
				by: String(ev.by ?? ""),
				at: ev.ts,
				evidence: String(ev.evidence ?? ""),
				findings: String(ev.findings ?? ""),
			};
			break;
		case "item": {
			const id = String(ev.id);
			taskOf(l, line);
			let byTask = l.items.get(line);
			if (!byTask) l.items.set(line, (byTask = new Map()));
			const next: Item = { ...(byTask.get(id) ?? { line, id, title: id, status: "" }), updated: ev.ts };
			for (const f of ["title", "status", "next", "chase", "pr", "source"] as const) {
				const v = ev[f];
				if (typeof v === "string") next[f] = v;
			}
			byTask.set(id, next);
			break;
		}
		case "ask":
			l.asks.set(Number(ev.n), { n: Number(ev.n), line, text: String(ev.text), opened: ev.ts });
			l.lastAsk = Math.max(l.lastAsk, Number(ev.n));
			break;
		case "ask_close":
			l.asks.delete(Number(ev.n));
			break;
		case "decision":
			l.decisions.push(ev);
			break;
		case "input":
			l.lastInput = ev.ts;
			l.lastInputSid = ev.sid;
			break;
		case "reply":
			l.lastReply = ev.ts;
			break;
		case "correction":
			l.corrections.set(Number(ev.n), { n: Number(ev.n), line, text: String(ev.text), opened: ev.ts });
			l.lastCorrection = Math.max(l.lastCorrection, Number(ev.n));
			break;
		case "correction_close":
			l.corrections.delete(Number(ev.n));
			break;
		case "action":
		case "inbox":
			l.actions.push(ev);
			break;
	}
}

export function append(ev: Omit<Ev, "ts">): void {
	mkdirSync(dirname(EVENTS), { recursive: true });
	appendFileSync(EVENTS, `${JSON.stringify({ ts: new Date().toISOString(), ...ev })}\n`);
}

export function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

export function openItems(l: Table): Item[] {
	return [...l.items.values()]
		.flatMap(byTask => [...byTask.values()])
		.filter(i => !isDone(i.status))
		.sort((a, b) => (a.chase ?? "9999").localeCompare(b.chase ?? "9999"));
}

// 未完成的任务：没写完成状态，并且登记过或还有未完成的事项（日常不算任务）
export function openTasks(l: Table): Task[] {
	return [...l.tasks.values()].filter(t => t.name !== GENERAL && !isDone(t.status) && (t.recorded || [...(l.items.get(t.name)?.values() ?? [])].some(i => !isDone(i.status))));
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// 子代理的名字对应哪个未完成任务：比较任务登记的负责 agent；旧任务没登记的，按名字比较任务名（PROJ-123 ↔ Proj123）。
// 对不上或有歧义返回 undefined
export function taskOfAgent(l: Table, name: string): Task | undefined {
	if (!name) return undefined;
	const open = openTasks(l);
	const exact = open.filter(t => t.agent === name);
	if (exact.length) return exact.length === 1 ? exact[0] : undefined;
	const legacy = open.filter(t => !t.agent && squash(t.name) === squash(name));
	return legacy.length === 1 ? legacy[0] : undefined;
}

// 审查者的名字是「负责 agent 的名字 + Review」，再审时后面加序号（Proj123Review、Proj123Review2；同名重派时 omp 会加成 Proj123Review-2）。
// 所以负责 agent 的名字不能长成这样
const REVIEWER_NAME = /^(.+)Review\d*(?:-\d+)?$/;
export const isReviewerName = (name: string) => REVIEWER_NAME.test(name);

// 这个子代理是哪个未完成任务的审查者：主会话派出的（一层，名字里没有点）、名字对得上、自己又不是哪个任务的负责 agent
export function taskOfReviewer(l: Table, id: string): Task | undefined {
	if (!id || id.includes(".") || taskOfAgent(l, id)) return undefined;
	const owner = REVIEWER_NAME.exec(id)?.[1];
	return owner ? taskOfAgent(l, owner) : undefined;
}

// 任务现在能不能记成完成：不能时返回原因（给模型看，英文）。agent、doneWhen 是这次调用里一并传的
export function doneBlocker(t: Task | undefined, name: string, agent?: string, doneWhen?: string): string | undefined {
	const owner = agent || t?.agent;
	if (!owner || !(doneWhen?.trim() || t?.doneWhen)) return `${name} has no owner agent or no done_when; register both before closing it as 完成, or close it as 取消`;
	if (t?.review?.verdict === "pass") return undefined;
	return `${name} has no passing review (latest: ${t?.review ? `${t.review.verdict} by ${t.review.by}` : "none"}). Spawn a reviewer with the task tool, name="${owner}Review" (add a number for a re-review, e.g. ${owner}Review2), and give it only where the result is. It records its verdict with tasktable_review.`;
}

// 负责 agent 的名字在未完成的任务里不能重复：程序靠名字把子代理对到任务
export const agentTaken = (l: Table, agent: string, exceptTask: string): boolean => openTasks(l).some(t => t.name !== exceptTask && t.agent === agent);

export function logError(where: string, err: unknown): void {
	try {
		mkdirSync(dirname(ERRLOG), { recursive: true });
		appendFileSync(ERRLOG, `${new Date().toISOString()} ${where}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	} catch {}
}

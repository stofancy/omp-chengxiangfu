// 账本：每个账本一份只追加的事件日志 courts/<账本>/events.jsonl。所有状态都从事件折叠出来。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COURTS, ERRLOG } from "./paths";

export const GENERAL = "日常"; // 不属于任何一路的事

export type Ev = { ts: string; sid: string; kind: string; line?: string; [k: string]: unknown };
export interface Item { line: string; id: string; title: string; status: string; owner?: string; next?: string; chase?: string; pr?: string; source?: string; updated: string }
export interface Ask { n: number; line: string; text: string; opened: string }
export interface Ledger {
	items: Map<string, Map<string, Item>>; // 线 → 任务号 → 任务
	asks: Map<number, Ask>; // 待用户决定
	lastAsk: number; // 编号只增不复用：迟到的「1 做」不会落到别的问题上
	corrections: Map<number, Ask>; // 用户的纠正，还没决定要不要写成规则
	lastCorrection: number;
	decisions: Ev[];
	actions: Ev[];
	lastInput?: string; // 用户最近一次在这个账本下发话的时间，决定不归线的外部消息送给谁
	lastInputSid?: string; // 那次发话所在的会话：同一账本开着几个会话时，外部消息只交给它
	lastReply?: string; // 最近一次给用户最终回复的时间：「离开多久」从发话和回复里较晚的那个算
}

export const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD，本地时区
export const isDone = (s: string) => /^(完成|done|closed|已完成|取消|cancelled|merged)/i.test(s.trim());
export const eventsOf = (court: string) => join(COURTS, court, "events.jsonl");

const cache = new Map<string, { key: string; ledger: Ledger }>();

export function readLedger(court: string): Ledger {
	const file = eventsOf(court);
	const st = existsSync(file) ? statSync(file) : undefined;
	const key = st ? `${st.mtimeMs}:${st.size}` : "none";
	const hit = cache.get(court);
	if (hit?.key === key) return hit.ledger;
	const ledger: Ledger = { items: new Map(), asks: new Map(), lastAsk: 0, corrections: new Map(), lastCorrection: 0, decisions: [], actions: [] };
	for (const raw of (st ? readFileSync(file, "utf8") : "").split("\n")) {
		if (!raw.trim()) continue;
		try {
			fold(ledger, JSON.parse(raw));
		} catch {
			// 并发追加时可能读到半行，下次再读
		}
	}
	cache.set(court, { key, ledger });
	return ledger;
}

function fold(l: Ledger, ev: Ev): void {
	const line = String(ev.line ?? "");
	switch (ev.kind) {
		case "item": {
			const id = String(ev.id);
			let byLine = l.items.get(line);
			if (!byLine) l.items.set(line, (byLine = new Map()));
			const next: Item = { ...(byLine.get(id) ?? { line, id, title: id, status: "" }), updated: ev.ts };
			for (const f of ["title", "status", "owner", "next", "chase", "pr", "source"] as const) {
				const v = ev[f];
				if (typeof v === "string") next[f] = v;
			}
			byLine.set(id, next);
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

export function append(court: string, ev: Omit<Ev, "ts">): void {
	const file = eventsOf(court);
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...ev })}\n`);
}

export function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

export function openItems(l: Ledger): Item[] {
	return [...l.items.values()]
		.flatMap(byLine => [...byLine.values()])
		.filter(i => !isDone(i.status))
		.sort((a, b) => (a.chase ?? "9999").localeCompare(b.chase ?? "9999"));
}

export const openLines = (l: Ledger) => new Set(openItems(l).map(i => i.line));

export function logError(where: string, err: unknown): void {
	try {
		mkdirSync(dirname(ERRLOG), { recursive: true });
		appendFileSync(ERRLOG, `${new Date().toISOString()} ${where}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	} catch {}
}

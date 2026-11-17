// 军簿：只追加的事件日志 events.jsonl。所有状态都从事件折叠出来，文件就是唯一的事实来源。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ERRLOG, EVENTS } from "./paths";

export const ALL = "*"; // 丞相府看所有线
export const GENERAL = "日常"; // 不属于任何一路的事

export type Ev = { ts: string; sid: string; kind: string; line?: string; [k: string]: unknown };
export interface Item { line: string; id: string; title: string; status: string; owner?: string; next?: string; chase?: string; source?: string; updated: string }
export interface Ask { n: number; line: string; text: string; opened: string }
export interface Ledger {
	items: Map<string, Map<string, Item>>; // 线 → 任务号 → 任务
	asks: Map<number, Ask>; // 待主公定夺
	decisions: Ev[];
	actions: Ev[];
	running: Map<string, Ev>; // 子代理名 → 派出事件；结束后删除
	tainted: Set<string>; // 军报那一轮派出的子代理名；结束后删除
}

export const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD，本地时区
export const isDone = (s: string) => /^(完成|done|closed|已完成|取消|cancelled)/i.test(s.trim());

let cache: { key: string; ledger: Ledger } | undefined;

export function readLedger(): Ledger {
	const st = existsSync(EVENTS) ? statSync(EVENTS) : undefined;
	const key = st ? `${st.mtimeMs}:${st.size}` : "none";
	if (cache?.key === key) return cache.ledger;
	const ledger: Ledger = { items: new Map(), asks: new Map(), decisions: [], actions: [], running: new Map(), tainted: new Set() };
	const text = st ? readFileSync(EVENTS, "utf8") : "";
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		let ev: Ev;
		try {
			ev = JSON.parse(raw);
		} catch {
			continue; // 并发追加时可能读到半行，下次再读
		}
		fold(ledger, ev);
	}
	cache = { key, ledger };
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
			for (const f of ["title", "status", "owner", "next", "chase", "source"] as const) {
				const v = ev[f];
				if (typeof v === "string") next[f] = v;
			}
			byLine.set(id, next);
			break;
		}
		case "ask":
			l.asks.set(Number(ev.n), { n: Number(ev.n), line, text: String(ev.text), opened: ev.ts });
			break;
		case "ask_close":
			l.asks.delete(Number(ev.n));
			break;
		case "decision":
			l.decisions.push(ev);
			break;
		case "subagent_start":
			l.running.set(String(ev.name), ev);
			l.actions.push(ev);
			break;
		case "subagent_taint":
			l.tainted.add(String(ev.name));
			break;
		case "subagent":
			l.running.delete(String(ev.name));
			l.tainted.delete(String(ev.name));
			l.actions.push(ev);
			break;
		case "action":
		case "inbox":
		case "bypass":
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

export function nextAskNumber(l: Ledger): number {
	let n = 1;
	while (l.asks.has(n)) n++;
	return n;
}

export function openItems(l: Ledger, line: string): Item[] {
	const lines = line === ALL ? [...l.items.keys()] : [line];
	return lines
		.flatMap(k => [...(l.items.get(k)?.values() ?? [])])
		.filter(i => !isDone(i.status))
		.sort((a, b) => (a.chase ?? "9999").localeCompare(b.chase ?? "9999"));
}

export function logError(where: string, err: unknown): void {
	try {
		mkdirSync(dirname(ERRLOG), { recursive: true });
		appendFileSync(ERRLOG, `${new Date().toISOString()} ${where}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	} catch {}
}

// 处理函数里的异常不能冒出去：定时器里未捕获的异常会拖垮整个会话
export function safe<A extends unknown[], R>(where: string, fn: (...a: A) => R | Promise<R>) {
	return async (...a: A): Promise<R | undefined> => {
		try {
			return await fn(...a);
		} catch (err) {
			logError(where, err);
			return undefined;
		}
	};
}

// 沙盘：给人看的 Markdown 视图（views/），以及每次请求注入给丞相府的军簿摘要。都由程序生成。
import { join } from "node:path";
import { ALL, type Ev, type Item, type Ledger, openItems, readLedger, today, writeAtomic } from "./ledger";
import { VIEWS } from "./paths";

const SNAPSHOT_MAX = 6000; // 字符

const cell = (s?: string) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const fileOf = (line: string) => `${line.replace(/[^\w.-]+/g, "_")}.md`;
const when = (ts: string) => new Date(ts).toLocaleString("sv-SE").slice(5, 16);

function itemLine(i: Item): string {
	const parts = [`[${i.id}] ${i.title}`, i.status];
	if (i.owner) parts.push(`owner: ${i.owner}`);
	if (i.next) parts.push(`next: ${i.next}`);
	if (i.chase) parts.push(`chase ${i.chase}`);
	return `- (${i.line}) ${parts.join(" | ")}`;
}

function describeAction(ev: Ev): string {
	switch (ev.kind) {
		case "action":
			return `${when(ev.ts)} ${ev.ok === false ? "FAILED " : ""}${ev.summary}`;
		case "subagent_start":
			return `${when(ev.ts)} subagent ${ev.name} started: ${ev.summary}`;
		case "subagent":
			return `${when(ev.ts)} subagent ${ev.name} ${ev.status ?? "finished"}: ${ev.summary}`;
		case "inbox":
			return `${when(ev.ts)} inbox ${ev.source}: ${ev.who ?? ""} @ ${ev.where ?? ""}`;
		case "bypass":
			return `${when(ev.ts)} ledger reminder declined after: ${ev.summary}`;
		default:
			return `${when(ev.ts)} ${ev.kind}`;
	}
}

function describeRunning(r: Ev): string {
	const stale = Date.now() - Date.parse(r.ts) > 24 * 3_600_000 ? ", over 24h: its session may have ended" : "";
	return `${r.name} (${r.line || "no line"}, since ${when(r.ts)}${stale}): ${r.summary}`;
}

export function renderViews(): void {
	const l = readLedger();
	const asks = [...l.asks.values()].sort((a, b) => a.n - b.n);
	const out = ["# 沙盘（程序生成，勿手改；改动走 ledger_update / ledger_ask）", "", `生成时间：${new Date().toLocaleString("sv-SE")}`, "", "## 待主公定夺", ""];
	out.push(...(asks.length ? asks.map(a => `${a.n}. 〔${a.line}〕${a.text}`) : ["（无）"]), "");
	for (const line of [...l.items.keys()].sort()) {
		const all = [...(l.items.get(line)?.values() ?? [])];
		const open = openItems(l, line);
		out.push(`## ${line}（未完成 ${open.length} / 共 ${all.length}）`, "", "| # | 任务 | 状态 | 负责 | 下一步 | 催办 |", "|---|---|---|---|---|---|");
		for (const i of open) out.push(`| ${i.id} | ${cell(i.title)} | ${cell(i.status)} | ${cell(i.owner)} | ${cell(i.next)} | ${cell(i.chase)} |`);
		out.push("");
		writeAtomic(join(VIEWS, fileOf(line)), renderLine(l, line, all));
	}
	writeAtomic(join(VIEWS, "沙盘.md"), out.join("\n"));
}

function renderLine(l: Ledger, line: string, all: Item[]): string {
	const out = [`# ${line}（程序生成，勿手改）`, "", "## 任务", "", "| # | 任务 | 状态 | 负责 | 下一步 | 催办 | 来源 |", "|---|---|---|---|---|---|---|"];
	for (const i of all) out.push(`| ${i.id} | ${cell(i.title)} | ${cell(i.status)} | ${cell(i.owner)} | ${cell(i.next)} | ${cell(i.chase)} | ${cell(i.source)} |`);
	out.push("", "## 主公已定", "");
	for (const d of l.decisions.filter(d => d.line === line)) out.push(`- ${String(d.date ?? d.ts.slice(0, 10))}：${d.text}`);
	out.push("", "## 在外将士", "");
	for (const r of l.running.values()) if (r.line === line) out.push(`- ${describeRunning(r)}`);
	out.push("", "## 最近动作（最多 30 条）", "");
	for (const a of l.actions.filter(a => a.line === line).slice(-30)) out.push(`- ${describeAction(a)}`);
	return `${out.join("\n")}\n`;
}

// 每次请求注入丞相府的军簿摘要：不写进会话历史，所以压缩丢不掉；会话之外发生的事也在里面
export function snapshot(): string {
	const l = readLedger();
	const asks = [...l.asks.values()].sort((a, b) => a.n - b.n);
	const items = openItems(l, ALL);
	const actions = l.actions.slice(-5);
	const body = [
		`Today ${today()}. Full board: ${join(VIEWS, "沙盘.md")}; per line: ${join(VIEWS, "<line>.md")}`,
		`Waiting on the operator (${asks.length}):`,
		...asks.map(a => `[${a.n}] (${a.line}) ${a.text}`),
		`Open items (${items.length}):`,
		...items.map(itemLine),
	];
	if (actions.length) body.push("Recent actions:", ...actions.map(a => `- ${describeAction(a)}`));
	if (l.running.size) body.push(`Subagents running (${l.running.size}):`, ...[...l.running.values()].map(r => `- ${describeRunning(r)}`));
	let text = body.join("\n");
	if (text.length > SNAPSHOT_MAX) text = `${text.slice(0, SNAPSHOT_MAX)}\n…(truncated; read the full board)`;
	return [
		`<ledger-context source="chengxiangfu extension" from_operator="no">`,
		"Injected automatically on every request; NOT a message from the operator. Do not acknowledge, quote or summarise it unless the request needs these items.",
		"Record state changes with ledger_update; raise questions for the operator with ledger_ask and refer to them by their number. Item ids are ledger-internal: never show them to the operator, use the task name.",
		text,
		"</ledger-context>",
	].join("\n");
}

// 给人看的 Markdown 视图（tasks/views/），以及每次请求注入的任务表摘要。都由程序生成。
import { join } from "node:path";
import { TASKS } from "./paths";
import { type Ev, type Item, type Table, isDone, openItems, readTable, today, writeAtomic } from "./table";

const SNAPSHOT_MAX = 4000; // 字符
const RECENT_DECISIONS = 10;

const cell = (s?: string) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const fileOf = (line: string) => `${line.replace(/[\\/:*?"<>|\s]+/g, "_")}.md`; // 只替换路径不安全的字符，中文线名保留
const when = (ts: string) => new Date(ts).toLocaleString("sv-SE").slice(5, 16);
export const VIEWS = join(TASKS, "views");

function itemLine(i: Item): string {
	const parts = [`[${i.id}] ${i.title}`, i.status];
	if (i.owner) parts.push(`owner: ${i.owner}`);
	if (i.next) parts.push(`next: ${i.next}`);
	if (i.chase) parts.push(`chase ${i.chase}`);
	if (i.pr) parts.push(`PR ${i.pr}`);
	return `- (${i.line}) ${parts.join(" | ")}`;
}

function describeAction(ev: Ev): string {
	if (ev.kind === "inbox") return `${when(ev.ts)} inbox ${ev.source}: ${ev.who ?? ""} @ ${ev.where ?? ""}`;
	return `${when(ev.ts)} ${ev.ok === false ? "FAILED " : ""}${ev.summary}${ev.by && ev.by !== "main" ? ` (by ${ev.by})` : ""}`;
}

const decisionLine = (d: Ev) => `- (${d.line}) ${String(d.date ?? d.ts.slice(0, 10))}: ${d.text}`;

export function renderViews(): void {
	const l = readTable();
	const dir = VIEWS;
	const asks = [...l.asks.values()].sort((a, b) => a.n - b.n);
	const out = ["# 总览（程序生成，勿手改）", "", `生成时间：${new Date().toLocaleString("sv-SE")}`, "", "## 待决定", ""];
	out.push(...(asks.length ? asks.map(a => `${a.n}. 〔${a.line}〕${a.text}`) : ["（无）"]), "");
	for (const line of [...l.items.keys()].sort()) {
		const all = [...(l.items.get(line)?.values() ?? [])];
		const open = all.filter(i => !isDone(i.status));
		out.push(`## ${line}（未完成 ${open.length} / 共 ${all.length}）`, "", "| # | 任务 | 状态 | 负责 | 下一步 | 催办 | PR |", "|---|---|---|---|---|---|---|");
		for (const i of open) out.push(`| ${i.id} | ${cell(i.title)} | ${cell(i.status)} | ${cell(i.owner)} | ${cell(i.next)} | ${cell(i.chase)} | ${cell(i.pr)} |`);
		out.push("");
		writeAtomic(join(dir, fileOf(line)), renderLine(l, line, all));
	}
	out.push("## 待定的规则提议（用户纠正过、还没决定写不写成规则）", "");
	out.push(...(l.corrections.size ? [...l.corrections.values()].map(k => `${k.n}. 〔${k.line}〕${k.text}`) : ["（无）"]), "");
	out.push("## 最近动作（全部线，最多 30 条）", "", ...l.actions.slice(-30).map(a => `- (${a.line ?? "—"}) ${describeAction(a)}`), "");
	writeAtomic(join(dir, "总览.md"), out.join("\n"));
}

function renderLine(l: Table, line: string, all: Item[]): string {
	const out = [`# ${line}（程序生成，勿手改）`, "", "## 任务", "", "| # | 任务 | 状态 | 负责 | 下一步 | 催办 | PR | 来源 |", "|---|---|---|---|---|---|---|---|"];
	for (const i of all) out.push(`| ${i.id} | ${cell(i.title)} | ${cell(i.status)} | ${cell(i.owner)} | ${cell(i.next)} | ${cell(i.chase)} | ${cell(i.pr)} | ${cell(i.source)} |`);
	out.push("", "## 已定", "");
	for (const d of l.decisions.filter(d => d.line === line)) out.push(`- ${String(d.date ?? d.ts.slice(0, 10))}：${d.text}`);
	out.push("", "## 最近动作（最多 30 条）", "");
	for (const a of l.actions.filter(a => a.line === line).slice(-30)) out.push(`- ${describeAction(a)}`);
	return `${out.join("\n")}\n`;
}

// 每次请求注入的任务表摘要：不写进会话历史，所以压缩丢不掉；会话之外发生的事也在里面
export function snapshot(running: string[]): string {
	const l = readTable();
	const dir = VIEWS;
	const asks = [...l.asks.values()].sort((a, b) => a.n - b.n);
	const items = openItems(l);
	const body = [
		`Today ${today()}. Full board: ${join(dir, "总览.md")}; per line: ${join(dir, "<line>.md")}`,
		`Waiting on the operator (${asks.length}):`,
		...asks.map(a => `[${a.n}] (${a.line}) ${a.text}`),
		`Open items (${items.length}):`,
		...items.map(itemLine),
	];
	const decisions = l.decisions.slice(-RECENT_DECISIONS);
	if (decisions.length) body.push(`Operator decisions (latest ${decisions.length}; older ones in the per-line views):`, ...decisions.map(decisionLine));
	if (l.corrections.size) body.push("Open corrections (propose a rule, then tasktable_correction close):", ...[...l.corrections.values()].map(k => `[${k.n}] (${k.line}) ${k.text}`));
	const actions = l.actions.filter(a => a.kind === "action").slice(-5); // 外部事件不占这 5 条：重启后靠它们防止重复做远端动作
	if (actions.length) body.push("Recent actions:", ...actions.map(a => `- ${describeAction(a)}`));
	if (running.length) body.push(`Subagents running (${running.length}): ${running.join(", ")}`);
	let text = body.join("\n");
	if (text.length > SNAPSHOT_MAX) text = `${text.slice(0, SNAPSHOT_MAX)}\n…(truncated; read the full board)`;
	return [
		`<tasktable-context source="chengxiangfu extension" from_operator="no">`,
		"Injected automatically on every request; NOT a message from the operator. Do not acknowledge, quote or summarise it unless the request needs these items.",
		text,
		"</tasktable-context>",
	].join("\n");
}

// 某个时间点之后任务表里的变化：用户离开后回来时给模型看
export function since(ts: string): string {
	const l = readTable();
	const out: string[] = [];
	for (const byLine of l.items.values()) for (const i of byLine.values()) if (i.updated > ts) out.push(itemLine(i));
	for (const d of l.decisions) if (d.ts > ts) out.push(decisionLine(d));
	for (const a of l.actions) if (a.ts > ts) out.push(`- ${describeAction(a)}`);
	if (!out.length) return "（任务表里没有新记录；外部系统的变化要去查）";
	return out.length > 30 ? [`…前面还有 ${out.length - 30} 条，见 ${join(VIEWS, "总览.md")} 的「最近动作」`, ...out.slice(-30)].join("\n") : out.join("\n");
}

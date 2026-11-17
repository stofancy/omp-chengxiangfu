// 军令：识别远端写入（尽力而为，不是审计）、硬禁区、军报那一轮派出的子代理。
import type { Ledger } from "./ledger";

const BASH_REMOTE: Array<[RegExp, string]> = [
	[/\bgit\b[^|;&\n]*\bpush\b/, "git push"],
	[/\bgh\s+(pr|issue)\s+(create|edit|comment|merge|close|reopen|review|ready)\b/, "gh write"],
	[/\bgh\s+api\b.*(-X|--method)\s*(POST|PATCH|PUT|DELETE)\b/i, "gh api write"],
	[/\b(chat\.(postMessage|update|delete|scheduleMessage)|reactions\.add|files\.(upload|completeUploadExternal))\b/, "slack write"],
	[/\baz\b(?!.*\b(list|show|get)\b).*\b(create|update|delete|set|assign|add|remove|start|stop|restart|upload|import)\b/, "az write"],
	[/\bcurl\b.*(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b/i, "curl write"],
];
// MCP 工具名形如 mcp__<server>_<operation>；先按操作名排除读操作，再认写操作
const MCP_READ = /^(get|list|search|read|query|fetch|discover|executeread)|(^|_)(read|get|list|search)$/i;
const MCP_WRITE = /(add|create|edit|update|delete|transition|merge|push|upsert|upload|link|write|destructive)/i;

// 硬禁区：丞相府和它派出的子代理永远不做，批准了也不做
const FORBIDDEN: Array<[RegExp, string]> = [
	[/\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/, "force push"],
	[/\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*\s(\S+:)?(main|master)\b(?!-)/, "push to main/master"],
];

export function redact(s: string): string {
	return s
		.replace(/(xox[abpr]-|xapp-|ghp_|gho_|github_pat_)[\w-]+/g, "$1***")
		.replace(/(Bearer\s+)\S+/gi, "$1***")
		.replace(/((password|pwd|secret|token|sig)=)[^&\s'"]+/gi, "$1***");
}

const commandOf = (toolName: string, input: Record<string, unknown> | undefined) => (toolName === "bash" ? String(input?.command ?? "") : "");

export function forbidden(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
	const cmd = commandOf(toolName, input);
	for (const [re, label] of FORBIDDEN) if (re.test(cmd)) return label;
	return undefined;
}

export function remoteWrite(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
	const cmd = commandOf(toolName, input);
	if (cmd) {
		for (const [re, label] of BASH_REMOTE) if (re.test(cmd)) return `${label}: ${redact(cmd).replace(/\s+/g, " ").slice(0, 160)}`;
		return undefined;
	}
	const path = String(input?.path ?? "");
	const mcp = toolName === "write" && path.startsWith("xd://mcp__") ? path.slice(5) : toolName.startsWith("mcp__") ? toolName : undefined;
	const op = mcp?.replace(/^mcp__[a-z0-9-]+?_/i, "");
	return mcp && op && !MCP_READ.test(op) && MCP_WRITE.test(op) ? `mcp ${mcp}` : undefined;
}

// task 工具有批量（tasks[]）和单个两种形状
type TaskItem = Record<string, unknown>;
const itemsOf = (input: Record<string, unknown>): TaskItem[] => (Array.isArray(input.tasks) ? input.tasks.filter((t): t is TaskItem => typeof t === "object" && t !== null) : [input]);

export function taskNames(input: Record<string, unknown>): string[] {
	return itemsOf(input)
		.map(t => t.name)
		.filter((n): n is string => typeof n === "string" && n.length > 0);
}

// 军报那一轮派出的子代理必须有名字，才能在派出前就记进军簿、被拦住
export function withNames(input: Record<string, unknown>): Record<string, unknown> {
	const stamp = Date.now().toString(36);
	const named = (t: TaskItem, i: number): TaskItem => (typeof t.name === "string" && t.name ? t : { ...t, name: `Inbox${stamp}${i}` });
	return Array.isArray(input.tasks) ? { ...input, tasks: itemsOf(input).map(named) } : named(input, 0);
}

// 子代理 id 形如 Name 或 Parent.Child；祖先被标记，子孙也算
export function isTainted(l: Ledger, id: string | undefined): boolean {
	if (!id) return false;
	const parts = id.split(".");
	return parts.some((p, i) => l.tainted.has(parts.slice(0, i + 1).join(".")) || l.tainted.has(p));
}

// 识别远端写入，只用来记账（不拦）。尽力而为：认不出来的就不记。
const GIT_PUSH = /(^|[|;&(\n]|&&)\s*(\w+=\S*\s+)*(env\s+|command\s+|sudo\s+)?(\S*\/)?git(\s+(-C\s+\S+|-c\s+\S+|--?[\w-]+(=\S+)?))*\s+push\b/;
const BASH_REMOTE: Array<[RegExp, string]> = [
	[GIT_PUSH, "git push"],
	[/\bgh\s+(pr|issue|release|repo)\s+(create|edit|comment|merge|close|reopen|review|ready|delete)\b/, "gh write"],
	[/\bgh\s+api\b.*(\s-X\s*|--method[\s=])(POST|PATCH|PUT|DELETE)\b/i, "gh api write"],
	[/\bgh\s+api\b(?!.*(\s-X\s*|--method[\s=])GET\b).*\s(-f|-F|--field|--raw-field|--input)\s/, "gh api write"],
	[/\b(chat\.(postMessage|update|delete|scheduleMessage)|reactions\.add|files\.(upload|completeUploadExternal))\b/, "slack write"],
	[/\baz\s+(?!account\b)(?!.*\s(list|show)(\s|$)).*\s(create|update|delete|set|assign|add|remove|start|stop|restart|upload|import)(\s|$)/, "az write"],
	[/\bcurl\b.*(\s-X\s*|--request[\s=])(POST|PUT|PATCH|DELETE)\b/i, "curl write"],
	[/\bcurl\b(?!.*(\s-X\s*|--request[\s=])GET\b).*\s(-d|--data[\w-]*|-F|--form|-T|--upload-file)[\s=]/, "curl write"],
];
// MCP 工具名形如 mcp__<server>_<operation>；先按操作名排除读操作，再认写操作
const MCP_READ = /^(get|list|search|read|query|fetch|discover|executeread)|(^|_)(read|get|list|search)$/i;
const MCP_WRITE = /(add|create|edit|update|delete|transition|merge|push|upsert|upload|link|write|destructive|send|post|reply)/i;

export function redact(s: string): string {
	return s
		.replace(/(xox[abpr]-|xapp-|ghp_|gho_|github_pat_)[\w-]+/g, "$1***")
		.replace(/(Bearer\s+)\S+/gi, "$1***")
		.replace(/((password|pwd|secret|token|sig)=)[^&\s'"]+/gi, "$1***");
}

export function remoteWrite(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
	if (toolName === "bash") {
		const cmd = String(input?.command ?? "");
		for (const [re, label] of BASH_REMOTE) if (re.test(cmd)) return `${label}: ${redact(cmd).replace(/\s+/g, " ").slice(0, 160)}`;
		return undefined;
	}
	const path = String(input?.path ?? "");
	const mcp = toolName === "write" && path.startsWith("xd://mcp__") ? path.slice(5) : toolName.startsWith("mcp__") ? toolName : undefined;
	const op = mcp?.replace(/^mcp__[a-z0-9-]+?_/i, "");
	return mcp && op && !MCP_READ.test(op) && MCP_WRITE.test(op) ? `mcp ${mcp}` : undefined;
}

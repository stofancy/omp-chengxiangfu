// 识别远端写入，只用来记账（不拦）。尽力而为：认不出来的就不记。
const GIT_PUSH = /(^|[|;&(\n]|&&)\s*(\w+=\S*\s+)*(env\s+|command\s+|sudo\s+)?(\S*\/)?git(\s+(-C\s+\S+|-c\s+\S+|--?[\w-]+(=\S+)?))*\s+push\b/;
// 在整条命令里找的：自带边界，或者出现在哪里都算
const ANYWHERE: Array<[RegExp, string]> = [
	[GIT_PUSH, "git push"],
	[/\bgh\s+(pr|issue|release|repo)\s+(create|edit|comment|merge|close|reopen|review|ready|delete)\b/, "gh write"],
	[/\b(chat\.(postMessage|update|delete|scheduleMessage)|reactions\.add|files\.(upload|completeUploadExternal))\b/, "slack write"],
];
// 靠参数判断的：只在同一条简单命令里找。一行里后面别的命令带 -f、-d（grep -F、cut -d）不算
const SAME_COMMAND: Array<[RegExp, string]> = [
	[/\bgh\s+api\b.*(\s-X\s*|--method[\s=])(POST|PATCH|PUT|DELETE)\b/i, "gh api write"],
	[/\bgh\s+api\b(?!.*(\s-X\s*|--method[\s=])GET\b).*\s(-f|-F|--field|--raw-field|--input)\s/, "gh api write"],
	[/\baz\s+(?!account\b)(?!.*\s(list|show)(\s|$)).*\s(create|update|delete|set|assign|add|remove|start|stop|restart|upload|import)(\s|$)/, "az write"],
	[/\bcurl\b.*(\s-X\s*|--request[\s=])(POST|PUT|PATCH|DELETE)\b/i, "curl write"],
	[/\bcurl\b(?!.*(\s-X\s*|--request[\s=])GET\b).*\s(-d|--data[\w-]*|-F|--form|-T|--upload-file)[\s=]/, "curl write"],
];

// 把一行 shell 拆成简单命令：在引号、$( )、( ) 外面的 | ; && 换行处断开。
// 不求完整：引号没配上时后面整段算一条命令，宁可多记不漏记。单个 & 不断开（2>&1、没加引号的 URL）
export function commands(cmd: string): string[] {
	const out: string[] = [];
	const open: string[] = []; // 还没闭合的 ' " (
	let start = 0;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		const top = open.at(-1);
		if (top === "'") {
			if (c === "'") open.pop();
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		const sub = c === "$" && cmd[i + 1] === "(";
		if (sub) i++;
		if (top === '"') {
			if (c === '"') open.pop();
			else if (sub) open.push("(");
		} else if (c === "'" || c === '"') open.push(c);
		else if (sub || c === "(") open.push("(");
		else if (c === ")" && top === "(") open.pop();
		else if (!open.length && (c === "|" || c === ";" || c === "\n" || (c === "&" && cmd[i + 1] === "&"))) {
			out.push(cmd.slice(start, i));
			start = i + 1;
		}
	}
	out.push(cmd.slice(start));
	return out;
}

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
		const label = ANYWHERE.find(([re]) => re.test(cmd))?.[1] ?? SAME_COMMAND.find(([re]) => commands(cmd).some(c => re.test(c)))?.[1];
		return label ? `${label}: ${redact(cmd).replace(/\s+/g, " ").slice(0, 160)}` : undefined;
	}
	const path = String(input?.path ?? "");
	const mcp = toolName === "write" && path.startsWith("xd://mcp__") ? path.slice(5) : toolName.startsWith("mcp__") ? toolName : undefined;
	const op = mcp?.replace(/^mcp__[a-z0-9-]+?_/i, "");
	return mcp && op && !MCP_READ.test(op) && MCP_WRITE.test(op) ? `mcp ${mcp}` : undefined;
}

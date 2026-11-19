// 子代理现在在做什么，以及它写好了却被 omp 压着没送到主会话的交回。
//
// omp 只在子代理完全空闲时才把结果送给派它的会话：子代理写完交回、这一轮结束了，但它自己还有后台命令或帮手在跑，
// 主会话就什么都收不到，一直等到那个后台命令结束（可能是几十分钟后的超时），而且到时送来的只是它最后说的话，前面那条交回就丢了。
// 这里让子代理那一侧把这种交回先记到文件里，主会话那一侧过了宽限期就自己送达。
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Step {
	what: string; // 最近一次工具调用的意图（模型自己写的一句话），没有就是工具名；这一轮已经结束时为空
	since: number; // 这一步开始的时间
	ended: boolean; // 最近一条是不带工具调用的回复：这一轮已经写完
}

const TAIL_BYTES = 256 * 1024;

// 读子代理会话文件的末尾，找它最近在做的那一步。读不到返回 undefined
export function lastStep(file: string): Step | undefined {
	let tail: string;
	try {
		const fd = openSync(file, "r");
		try {
			const size = fstatSync(fd).size;
			const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
			readSync(fd, buf, 0, buf.length, size - buf.length);
			tail = buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
	const lines = tail.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].includes('"assistant"')) continue;
		let entry: { type?: string; timestamp?: string; message?: { role?: string; content?: Array<{ type?: string; name?: string; arguments?: { i?: unknown } }> } };
		try {
			entry = JSON.parse(lines[i]);
		} catch {
			continue; // 末尾截出来的半行
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		const since = Date.parse(entry.timestamp ?? "");
		if (Number.isNaN(since)) continue;
		const call = entry.message.content.filter(b => b.type === "toolCall").at(-1);
		if (!call) return { what: "", since, ended: true };
		return { what: typeof call.arguments?.i === "string" && call.arguments.i ? call.arguments.i : (call.name ?? ""), since, ended: false };
	}
	return undefined;
}

// ---------- 被压着的交回：每个主会话一个目录，每个子代理一个文件，里面是还没送达的几条 ----------

export interface Held { agent: string; at: number; text: string }

const fileOf = (dir: string, agent: string) => join(dir, `${agent.replace(/[\\/]/g, "_")}.json`);
function load(file: string): Array<{ at: number; text: string }> {
	try {
		const v = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}
function save(file: string, entries: Array<{ at: number; text: string }>): void {
	if (!entries.length) return rmSync(file, { force: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(entries));
	renameSync(tmp, file); // 两个进程（子代理那一侧写、主会话那一侧取）不会读到半个文件
}

// 子代理那一侧：这一轮写完了交回，但自己还有后台的活，omp 暂时不会送
export function holdHandback(dir: string, agent: string, text: string, at: number): void {
	mkdirSync(dir, { recursive: true });
	const file = fileOf(dir, agent);
	save(file, [...load(file).filter(e => e.text !== text), { at, text }]);
}

// 子代理那一侧：它完全空闲了，omp 会正常送这一条。同文的不用再送
export function releaseHandback(dir: string, agent: string, text: string): void {
	const file = fileOf(dir, agent);
	if (existsSync(file)) save(file, load(file).filter(e => e.text !== text));
}

// 主会话那一侧：取出过了宽限期的（宽限期内 omp 自己送达的会被 releaseHandback 撤掉）
export function dueHandbacks(dir: string, now: number, graceMs: number): Held[] {
	if (!existsSync(dir)) return [];
	const out: Held[] = [];
	for (const f of readdirSync(dir).filter(n => n.endsWith(".json"))) {
		const file = join(dir, f);
		const entries = load(file);
		const due = entries.filter(e => now - e.at >= graceMs);
		if (!due.length) continue;
		save(file, entries.filter(e => now - e.at < graceMs));
		out.push(...due.map(e => ({ agent: f.slice(0, -5), ...e })));
	}
	return out.sort((a, b) => a.at - b.at);
}

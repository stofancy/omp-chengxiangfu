import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dueHandbacks, holdHandback, lastStep, releaseHandback } from "./agents";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dispatch-desk-agents-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (ts: string, content: unknown[]) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content } });

test("子代理在做哪一步：最近一次工具调用的意图和开始时间；最近一条是纯文字回复就是这一轮写完了", () => {
	const file = join(dir, "Owner.jsonl");
	writeFileSync(
		file,
		[
			entry("2026-11-19T05:15:40.000Z", [{ type: "toolCall", name: "bash", arguments: { command: "x", i: "Pushing bundle in chunks" } }]),
			JSON.stringify({ type: "message", timestamp: "2026-11-19T05:15:41.000Z", message: { role: "toolResult", content: [{ type: "text", text: 'said "assistant" here' }] } }),
			entry("2026-11-19T05:15:47.000Z", [{ type: "text", text: "等一下" }, { type: "toolCall", name: "wait", arguments: { i: "Waiting for bundle push" } }]),
			"",
		].join("\n"),
	);
	expect(lastStep(file)).toEqual({ what: "Waiting for bundle push", since: Date.parse("2026-11-19T05:15:47.000Z"), ended: false });
	writeFileSync(file, `${entry("2026-11-19T05:15:47.000Z", [{ type: "toolCall", name: "wait", arguments: {} }])}\n${entry("2026-11-19T05:20:00.000Z", [{ type: "text", text: "待审查：改好了" }])}\n`);
	expect(lastStep(file)).toEqual({ what: "", since: Date.parse("2026-11-19T05:20:00.000Z"), ended: true });
	expect(lastStep(join(dir, "nobody.jsonl"))).toBeUndefined();
});

test("被压着的交回：过了宽限期的才取出来，取过的不再取；宽限期内 omp 自己送达的同一条被撤掉，不同的一条照送", () => {
	holdHandback(dir, "Owner", "待审查：第一条", 1_000);
	holdHandback(dir, "Owner", "待审查：第一条", 2_000); // 同一条又写一次：只留一条
	holdHandback(dir, "Owner", "做完：第二条", 20_000);
	expect(dueHandbacks(dir, 18_000, 15_000)).toEqual([{ agent: "Owner", at: 2_000, text: "待审查：第一条" }]);
	expect(dueHandbacks(dir, 18_000, 15_000)).toEqual([]);
	releaseHandback(dir, "Owner", "别的话"); // omp 送达的是后来的另一句：前面那条还得由程序送
	expect(dueHandbacks(dir, 40_000, 15_000).map(h => h.text)).toEqual(["做完：第二条"]);
	holdHandback(dir, "Owner", "要用户定：第三条", 50_000);
	releaseHandback(dir, "Owner", "要用户定：第三条"); // omp 正常送达了这一条
	expect(dueHandbacks(dir, 99_000, 15_000)).toEqual([]);
});

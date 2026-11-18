import { expect, test } from "bun:test";
import { foldEvents } from "./table";
import { decidedFor, snapshot } from "./views";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 1, minute)).toISOString();
const ev = (minute: number, kind: string, line: string | undefined, extra: Record<string, unknown> = {}) => JSON.stringify({ ts: at(minute), sid: "s", kind, line, ...extra });

test("摘要里的远端写入各自配上之前 30 分钟内用户对这个任务的决定（最多两条，近的在前）；没有的、只有别的任务的决定的，标成没有", () => {
	const text = snapshot(
		[],
		foldEvents([
			ev(0, "task", "A", { agent: "TaskA", done_when: "x" }),
			ev(0, "decision", "A", { text: "更早的决定" }),
			ev(1, "decision", "A", { text: "推不推到 PR 分支 → 推" }),
			ev(2, "decision", "A", { text: "每日总结 → 改" }),
			ev(3, "action", "A", { summary: "git push: one", by: "TaskA" }),
			ev(40, "decision", "B", { text: "别的任务的决定" }),
			ev(41, "action", "A", { summary: "git push: two", by: "TaskA" }),
		]),
	);
	expect(text).toContain('git push: one (by TaskA) ← operator decisions before it: 1 min earlier "每日总结 → 改"; 2 min earlier "推不推到 PR 分支 → 推"');
	expect(text).not.toContain('"更早的决定"');
	expect(text).toContain("git push: two (by TaskA) ← NO operator decision on this task in the 30 min before");
});

test("摘要超长时省掉的是放不下的事项和用户决定：待决定的事、每个任务和负责 agent、远端写入、在跑的 agent 都还在", () => {
	const long = "很长的决定".repeat(60);
	const events = [ev(0, "task", "A", { agent: "TaskA", done_when: "x" }), ev(0, "task", "B", { agent: "TaskB", done_when: "x" }), ev(1, "ask", "A", { n: 7, text: "要不要发" }), ev(2, "action", "A", { summary: "slack write: hello", by: "TaskA" })];
	for (let i = 0; i < 30; i++) events.push(ev(3, "decision", "A", { text: `${i} ${long}` }), ev(3, "item", "A", { id: `T${i}`, title: "事项", status: "进行中", next: long }));
	const text = snapshot(["TaskA"], foldEvents(events));
	expect(text).toContain("more not shown; read the full board)");
	expect(text).not.toContain("[T29]");
	expect(text).toContain("[7] (A) 要不要发");
	expect(text).toContain("B | owner agent://TaskB");
	expect(text).toContain("slack write: hello");
	expect(text).toContain("Agents running (1): TaskA");
	expect(text.length).toBeLessThan(5000);
});

test("只有一条用户决定时，摘要里也有它", () => {
	expect(snapshot([], foldEvents([ev(0, "task", "A", { agent: "TaskA", done_when: "x" }), ev(1, "decision", "A", { text: "只有这一条" })]))).toContain("只有这一条");
});

test("登记提问时列给模型看的：这个任务已有的决定和别的没答的提问，不含别的任务的、不含刚登记的这一条", () => {
	const l = foldEvents([
		ev(0, "decision", "A", { text: "列顺序 → 已定" }),
		ev(1, "decision", "B", { text: "别的任务" }),
		ev(2, "ask", "A", { n: 3, text: "旧问题" }),
		ev(3, "ask", "A", { n: 4, text: "刚登记的" }),
	]);
	const text = decidedFor(l, "A", 4);
	expect(text).toContain("列顺序 → 已定");
	expect(text).toContain("[3] 旧问题");
	expect(text).not.toContain("别的任务");
	expect(text).not.toContain("刚登记的");
	expect(decidedFor(l, "C", 0)).toBe("");
});

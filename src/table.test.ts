import { expect, test } from "bun:test";
import { agentTaken, foldEvents, openTasks, taskOfAgent } from "./table";

let n = 0;
const ev = (kind: string, line: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ts: new Date(Date.UTC(2026, 10, 18, 0, 0, n++)).toISOString(), sid: "s", kind, line, ...extra });

test("任务记录：后写的字段覆盖先写的，没传的保留；盯的外部输入可加可减", () => {
	const l = foldEvents([
		ev("task", "PROJ-1", { agent: "Proj1", goal: "修登录", done_when: "bun test 通过", watch_add: ["https://x.slack.com/archives/C1/p1700000000000100", "PROJ-1"] }),
		ev("task", "PROJ-1", { goal: "修登录和登出", watch_add: ["https://github.com/o/r/pull/7"], watch_remove: ["PROJ-1"] }),
	]);
	expect(l.tasks.get("PROJ-1")).toMatchObject({
		recorded: true,
		agent: "Proj1",
		goal: "修登录和登出",
		doneWhen: "bun test 通过",
		watch: ["https://x.slack.com/archives/C1/p1700000000000100", "https://github.com/o/r/pull/7"],
	});
});

test("未完成的任务：登记过的算；只有事项的旧任务有未完成事项才算；日常和已完成的不算", () => {
	const l = foldEvents([
		ev("task", "A", { agent: "TaskA", done_when: "x" }),
		ev("task", "B", { agent: "TaskB", done_when: "x" }),
		ev("task", "B", { status: "完成" }),
		ev("item", "OLD-1", { id: "T1", status: "进行中" }),
		ev("item", "OLD-2", { id: "T1", status: "完成" }),
		ev("item", "日常", { id: "T1", status: "进行中" }),
	]);
	expect(openTasks(l).map(t => t.name).sort()).toEqual(["A", "OLD-1"]);
	expect(l.tasks.get("OLD-1")?.recorded).toBe(false);
});

test("子代理的名字对到任务：登记的名字精确比较；旧任务按任务名比较；已完成的任务对不上", () => {
	const l = foldEvents([
		ev("task", "注意力统计", { agent: "AttnStats", done_when: "x" }),
		ev("item", "OLD-12", { id: "T1", status: "进行中" }),
		ev("task", "DONE", { agent: "DoneOne", done_when: "x", status: "完成" }),
	]);
	expect(taskOfAgent(l, "AttnStats")?.name).toBe("注意力统计");
	expect(taskOfAgent(l, "attnstats")).toBeUndefined();
	expect(taskOfAgent(l, "Old12")?.name).toBe("OLD-12");
	expect(taskOfAgent(l, "DoneOne")).toBeUndefined();
	expect(taskOfAgent(l, "Stranger")).toBeUndefined();
});

test("负责 agent 的名字：别的未完成任务在用就算被占；自己的、已完成任务的不算", () => {
	const l = foldEvents([ev("task", "A", { agent: "Shared", done_when: "x" }), ev("task", "B", { agent: "Old", done_when: "x", status: "取消" })]);
	expect(agentTaken(l, "Shared", "C")).toBe(true);
	expect(agentTaken(l, "Shared", "A")).toBe(false);
	expect(agentTaken(l, "Old", "C")).toBe(false);
});

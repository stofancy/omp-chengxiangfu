import { expect, test } from "bun:test";
import { matchTask, observed, watchPlan } from "./watch";

const ROOT = "https://acme.slack.com/archives/C111/p1700000000000100";
const REPLY = "https://acme.slack.com/archives/C111/p1700000555000200?thread_ts=1700000000.000100";
const OTHER_THREAD = "https://acme.slack.com/archives/C111/p1700009999000300";
const CHANNEL = "https://acme.slack.com/archives/C111";

const one = (watch: string[], link: string, extra: { where?: string; note?: string } = {}) => matchTask({ link, ...extra }, [{ name: "A", watch }]).task;

test("Slack thread：登记根消息，thread 里的回复归过来；登记某条回复，根消息和别的回复也归过来", () => {
	expect(one([ROOT], REPLY)).toBe("A");
	expect(one([REPLY], ROOT)).toBe("A");
	expect(one([REPLY], "https://acme.slack.com/archives/C111/p1700000777000400?thread_ts=1700000000.000100&cid=C111")).toBe("A");
});

test("Slack：别的 thread、别的频道不归；只登记到频道的，频道里的消息和 thread 回复都归", () => {
	expect(one([ROOT], OTHER_THREAD)).toBeUndefined();
	expect(one([ROOT], "https://acme.slack.com/archives/C222/p1700000000000100")).toBeUndefined();
	expect(one([CHANNEL], OTHER_THREAD)).toBe("A");
	expect(one([CHANNEL], REPLY)).toBe("A");
});

test("PR：GitHub 和 Azure DevOps 的地址忽略后面的路径、查询串、锚点；别的 PR 号不归", () => {
	expect(one(["https://github.com/org/repo/pull/12"], "https://github.com/org/repo/pull/12#issuecomment-99")).toBe("A");
	expect(one(["https://github.com/org/repo/pull/12/files"], "https://github.com/Org/Repo/pull/12?notification=1")).toBe("A");
	expect(one(["https://github.com/org/repo/pull/12"], "https://github.com/org/repo/pull/123")).toBeUndefined();
	expect(one(["https://dev.azure.com/acme/Proj/_git/svc/pullrequest/77"], "https://dev.azure.com/acme/Proj/_git/svc/pullrequest/77?_a=files")).toBe("A");
});

test("工单号等标识：在 where / note / link 里按整词出现才归", () => {
	expect(one(["PROJ-12"], "https://x.example/1", { where: "PROJ-12: 修登录" })).toBe("A");
	expect(one(["PROJ-12"], "https://tracker.example/browse/PROJ-12")).toBe("A");
	expect(one(["PROJ-12"], "https://x.example/1", { where: "PROJ-123: 别的" })).toBeUndefined();
});

test("其他链接：去掉查询串和末尾斜杠后相等才归", () => {
	expect(one(["https://wiki.example/page/1/"], "https://wiki.example/page/1?x=1")).toBe("A");
	expect(one(["https://wiki.example/page/1"], "https://wiki.example/page/10")).toBeUndefined();
});

test("命中几个任务：thread 级压过频道级；同一级仍然几个就都不归，并列出候选", () => {
	const tasks = [
		{ name: "频道", watch: [CHANNEL] },
		{ name: "这条 thread", watch: [ROOT] },
	];
	expect(matchTask({ link: REPLY }, tasks)).toEqual({ task: "这条 thread", candidates: [] });
	expect(matchTask({ link: REPLY }, [...tasks, { name: "也盯这条", watch: [REPLY] }])).toEqual({ task: undefined, candidates: ["这条 thread", "也盯这条"] });
	expect(matchTask({ link: "https://nowhere.example/x" }, tasks)).toEqual({ task: undefined, candidates: [] });
});

test("哪些盯办项有接收程序在读：Slack 的链接（配了 Slack 才算）、GitHub 的 PR、配置的那个 Azure DevOps 组织的 PR；工单号、别的链接、随手写的说明都没有", () => {
	const all = { slack: true, ado: "acme" };
	expect(observed("https://acme.slack.com/archives/D0AAAAAAAAA", all)).toBe(true);
	expect(observed("https://acme.slack.com/archives/C0BBBBBBBBB/p1700000123000400", all)).toBe(true);
	expect(observed("https://acme.slack.com/archives/C0BBBBBBBBB/p1700000123000400", { slack: false })).toBe(false);
	expect(observed("https://github.com/o/r/pull/37", { slack: false })).toBe(true);
	expect(observed("https://dev.azure.com/acme/Proj/_git/repo/pullrequest/12", all)).toBe(true);
	expect(observed("https://dev.azure.com/other/Proj/_git/repo/pullrequest/12", all)).toBe(false);
	expect(observed("https://dev.azure.com/acme/Proj/_git/repo/pullrequest/12", { slack: true })).toBe(false);
	for (const blind of ["OPS-42", "https://acme.atlassian.net/browse/PROJ-42", "slack:D0AAAAAAAAA (和某人的私信)", "https://github.com/o/r/issues/5"]) expect(observed(blind, all)).toBe(false);
});

test("交给接收程序的清单：频道和私信整个读，thread 带上那条消息的时间戳，PR 拆成仓库和编号；读不到的不进清单，同一项只留一条", () => {
	const plan = watchPlan(
		[
			{ name: "A", watch: ["https://acme.slack.com/archives/D0AAAAAAAAA", "https://acme.slack.com/archives/C0BBBBBBBBB/p1700000123000400", "OPS-42", "https://github.com/O/R/pull/37#issuecomment-1"] },
			{ name: "B", watch: ["https://acme.slack.com/archives/C0BBBBBBBBB/p1700000123999999?thread_ts=1700000123.000400", "https://github.com/o/r/pull/37", "https://dev.azure.com/acme/My%20Proj/_git/repo/pullrequest/12?_a=files"] },
		],
		{ slack: true, ado: "acme" },
	);
	expect(plan.slack).toEqual([
		{ task: "A", channel: "D0AAAAAAAAA", thread: undefined },
		{ task: "A", channel: "C0BBBBBBBBB", thread: "1700000123.000400" },
	]);
	expect(plan.github).toEqual([{ task: "A", repo: "O/R", number: 37 }]);
	expect(plan.ado).toEqual([{ task: "B", project: "My Proj", repo: "repo", id: 12 }]);
});

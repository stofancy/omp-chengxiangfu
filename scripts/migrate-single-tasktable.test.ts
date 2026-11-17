import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "./migrate-single-tasktable";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "tasktable-migrate-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ev = (ts: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ts, sid: "s", kind: "item", line: "L", id: "T1", ...extra });

function seed() {
	const dup = ev("2026-11-02T00:00:00.000Z", { title: "共有" });
	mkdirSync(join(home, "courts/a"), { recursive: true });
	mkdirSync(join(home, "courts/b"), { recursive: true });
	writeFileSync(join(home, "courts/a/events.jsonl"), [ev("2026-11-03T00:00:00.000Z", { title: "a3" }), dup, ev("2026-11-01T00:00:00.000Z", { title: "a1" })].join("\n") + "\n");
	writeFileSync(join(home, "courts/a/name"), "账本甲");
	writeFileSync(join(home, "courts/b/events.jsonl"), [dup, ev("2026-11-04T00:00:00.000Z", { title: "b4" })].join("\n") + "\n");
	mkdirSync(join(home, "bindings"));
	writeFileSync(join(home, "bindings/sess1"), "a");
	return dup;
}

test("合并两本旧账本：按时间排序、去重、旧目录进 archive", () => {
	seed();
	const r = migrate(home, new Date(2026, 10, 18, 15, 30, 45));
	expect(r).toMatchObject({ migrated: true, lines: 4, duplicates: 1, skipped: 0 });
	const lines = readFileSync(join(home, "tasks/events.jsonl"), "utf8").trimEnd().split("\n");
	expect(lines.map(l => JSON.parse(l).title)).toEqual(["a1", "共有", "a3", "b4"]);
	expect(existsSync(join(home, "courts"))).toBe(false);
	expect(existsSync(join(home, "bindings"))).toBe(false);
	expect(readdirSync(join(home, "archive"))).toEqual(["20261118-153045"]);
	expect(existsSync(join(home, "archive/20261118-153045/courts/a/events.jsonl"))).toBe(true);
	expect(existsSync(join(home, "archive/20261118-153045/courts/a/name"))).toBe(true);
	expect(readFileSync(join(home, "archive/20261118-153045/bindings/sess1"), "utf8")).toBe("a");
});

test("再运行一次：什么都不做，不重复写", () => {
	seed();
	migrate(home);
	const before = readFileSync(join(home, "tasks/events.jsonl"), "utf8");
	const archives = readdirSync(join(home, "archive"));
	const r = migrate(home);
	expect(r.migrated).toBe(false);
	expect(r.reason).toContain("已经迁移过");
	expect(readFileSync(join(home, "tasks/events.jsonl"), "utf8")).toBe(before);
	expect(readdirSync(join(home, "archive"))).toEqual(archives);
});

test("已有的任务表内容也保留，不合法的行跳过并计数", () => {
	mkdirSync(join(home, "tasks"), { recursive: true });
	writeFileSync(join(home, "tasks/events.jsonl"), `${ev("2026-11-05T00:00:00.000Z", { title: "新" })}\n`);
	mkdirSync(join(home, "courts/a"), { recursive: true });
	writeFileSync(join(home, "courts/a/events.jsonl"), `${ev("2026-11-01T00:00:00.000Z", { title: "旧" })}\n{半行\n`);
	const r = migrate(home);
	expect(r).toMatchObject({ lines: 2, skipped: 1 });
	expect(readFileSync(join(home, "tasks/events.jsonl"), "utf8").trimEnd().split("\n").map(l => JSON.parse(l).title)).toEqual(["旧", "新"]);
});

test("没有旧数据：不创建任何东西", () => {
	const r = migrate(home);
	expect(r.migrated).toBe(false);
	expect(readdirSync(home)).toEqual([]);
});

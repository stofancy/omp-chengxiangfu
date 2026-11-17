import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOn, setOn } from "./switch";

let dir: string;
beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), "dispatch-switch-")), "state");
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

test("默认关；打开只对这个会话生效，换个进程再看仍然是开的；关掉后恢复", () => {
	expect(isOn("s1", dir)).toBe(false);
	expect(isOn(undefined, dir)).toBe(false);
	setOn("s1", true, dir);
	expect(isOn("s1", dir)).toBe(true);
	expect(isOn("s2", dir)).toBe(false);
	setOn("s1", false, dir);
	expect(isOn("s1", dir)).toBe(false);
	setOn("never-on", false, dir); // 关一个没开过的不报错
});

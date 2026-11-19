import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeStamp } from "./screen";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cxf-stamp-"));
	mkdirSync(join(dir, "src"));
	mkdirSync(join(dir, "prompts"));
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, "src", "a.test.ts"), "test\n");
	writeFileSync(join(dir, "prompts", "规则.md"), "旧规则\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("插件的指纹：代码或自带的规则改了就变（固定区据此提示重启），只改测试文件不变", () => {
	const before = codeStamp(dir);
	writeFileSync(join(dir, "src", "a.test.ts"), "changed test\n");
	expect(codeStamp(dir)).toBe(before);
	writeFileSync(join(dir, "prompts", "规则.md"), "新规则\n");
	const prompts = codeStamp(dir);
	expect(prompts).not.toBe(before);
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	expect(codeStamp(dir)).not.toBe(prompts);
});

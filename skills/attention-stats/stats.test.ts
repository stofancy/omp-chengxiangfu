// 注意力统计的测试：用 fixtures 里的假数据，以子进程跑脚本，断言输出（时区固定为 UTC）
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const HERE = import.meta.dir;
const FIX = join(HERE, "fixtures");

function run(args: string[], tz = "UTC") {
	const p = Bun.spawnSync(
		["bun", join(HERE, "stats.ts"), "--data", join(FIX, "data"), "--sessions", join(FIX, "sessions"), ...args],
		{ env: { ...process.env, TZ: tz } },
	);
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("按天汇总", () => {
	const { code, out } = run(["--since", "2026-11-10", "--until", "2026-11-12"]);

	test("退出码 0，两张表都在", () => {
		expect(code).toBe(0);
		expect(out).toContain("## 按天");
		expect(out).toContain("## 按任务");
	});

	// 11-10：主会话 3 条 + 另一个项目 1 条；助手、工具结果、插件注入、agent 归因、子代理文件都不计
	test("条数和字数（不含空白）", () => {
		expect(out).toContain("| 2026-11-10 | 4 | 25 | 6.0 |");
		expect(out).toContain("| 2026-11-11 | 3 | 26 | 6.0 |");
		expect(out).toContain("| 合计 | 7 | 51 | 12.0 |");
	});

	// 11-10：09:00、09:03、09:05 连续（间隔累计 5 分钟，跨会话文件合并计算），09:20 落单记 1 分钟
	// 11-11：10:00 与 10:05 间隔恰好 5 分钟算连续（5 分钟），10:10:01 比 10:05 晚 5 分 1 秒，断开后落单记 1 分钟
	test("活跃分钟的间隔规则", () => {
		expect(out).toContain("| 2026-11-10 | 4 | 25 | 6.0 |");
		expect(out).toContain("| 2026-11-11 | 3 | 26 | 6.0 |");
	});

	test("范围之外的天不出现", () => {
		expect(out).not.toContain("2026-11-20 |");
	});
});

describe("排除非用户输入", () => {
	const { out } = run(["--since", "2026-11-10", "--until", "2026-11-10"]);

	test("只有 4 条：不含 agent 归因、子代理文件、助手、工具结果、插件注入", () => {
		expect(out).toContain("| 合计 | 4 | 25 | 6.0 |");
	});
});

describe("子代理文件不计入", () => {
	test("子代理文件里的消息不影响 11-10 的条数", () => {
		const { out } = run(["--since", "2026-11-10", "--until", "2026-11-10"]);
		// 子代理那条在 09:01，若被算进去，条数是 5 且活跃分钟不同
		expect(out).toContain("| 2026-11-10 | 4 | 25 | 6.0 |");
	});
});

describe("按任务归类", () => {
	const { out } = run(["--since", "2026-11-10", "--until", "2026-11-12"]);

	// ABC-100：消息 3（含大小写不同的 abc-100）、决定 2、提问 1、纠正 1；ask_close 和范围外的事件不计
	test("编号任务的消息、决定、提问、纠正", () => {
		expect(out).toContain("| ABC-100 | 3 | 2 | 1 | 1 |");
		expect(out).toContain("| ABC-200 | 1 | 1 | 0 | 0 |");
	});

	test("一条消息提到两个任务，各算一次", () => {
		// 11-11 第一条同时提到 abc-200 和 ABC-100：ABC-200 的 1 条就是它，ABC-100 的 3 条里也有它
		expect(out).toContain("| ABC-200 | 1 |");
	});

	test("「日常」只统计事件，不做文本匹配", () => {
		expect(out).toContain("| 日常 | 0 | 0 | 1 | 0 |");
	});

	test("没提到任务编号的进未归类，且排在最后", () => {
		expect(out).toContain("| 未归类 | 4 | 0 | 0 | 0 |");
		const rows = out.split("\n").filter((l) => l.startsWith("| ") && /^\| (ABC|日常|未归类)/.test(l));
		expect(rows.at(-1)).toStartWith("| 未归类");
	});
});

describe("日期范围过滤", () => {
	test("since/until 都含当天", () => {
		const { out } = run(["--since", "2026-11-11", "--until", "2026-11-11"]);
		expect(out).toContain("| 合计 | 3 | 26 | 6.0 |");
		expect(out).not.toContain("| 2026-11-10 |");
		// 11-10 的事件被过滤掉，只剩 11-11 的
		expect(out).toContain("| ABC-100 | 1 | 0 | 0 | 1 |");
	});

	test("范围里没有数据时输出说明而不是空表", () => {
		const { code, out } = run(["--since", "2026-01-01", "--until", "2026-01-02"]);
		expect(code).toBe(0);
		expect(out).toContain("这段时间没有用户消息。");
		expect(out).toContain("这段时间没有任务记录。");
	});

	test("按运行机器的本地时区算日期", () => {
		// UTC+14：11-11 10:00Z 起已经是本地 11-12 零点之后
		const { out } = run(["--since", "2026-11-10", "--until", "2026-11-12"], "Pacific/Kiritimati");
		expect(out).toContain("| 2026-11-12 | 3 |");
	});
});

describe("参数错误", () => {
	test("日期格式不对：退出码 1，错误信息走 stderr", () => {
		const { code, err, out } = run(["--since", "昨天"]);
		expect(code).toBe(1);
		expect(err).toContain("YYYY-MM-DD");
		expect(out).toBe("");
	});

	test("数据目录不存在：照常输出空结果", () => {
		const p = Bun.spawnSync(["bun", join(HERE, "stats.ts"), "--data", "/nonexistent-x", "--sessions", "/nonexistent-y"]);
		expect(p.exitCode).toBe(0);
		expect(p.stdout.toString()).toContain("这段时间没有用户消息。");
	});
});

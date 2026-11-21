import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasFeishu, readConfig, runSetup, type SetupUI } from "./setup";

function questions(choices: string[], inputs: string[] = []) {
	const notices: string[] = [];
	const prefill: Array<string | undefined> = [];
	const ui: SetupUI = {
		async select(_title, options) {
			const prefix = choices.shift();
			const selected = options.find(option => option.startsWith(prefix ?? ""));
			expect(prefix).toBeDefined();
			expect(selected).toBeDefined();
			return selected;
		},
		async input() {
			expect(inputs.length).toBeGreaterThan(0);
			return inputs.shift();
		},
		async editor(_title, current) {
			prefill.push(current);
			return "示例用户，负责示例项目";
		},
		async confirm() { return true; },
		notify(message) { notices.push(message); },
	};
	return { ui, notices, prefill };
}

const unexpected = async () => { throw new Error("不应调用外部服务"); };

async function tempConfig(fn: (path: string, dir: string) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "dispatch-setup-test-"));
	try {
		await fn(join(dir, "config.json"), dir);
	} finally {
		rmSync(dir, { recursive: true });
	}
}

test("分拣编辑带当前值，保留其他配置和分拣命令，保存前备份原文", () => tempConfig(async (path, dir) => {
	const before = '{"triage":{"about":"旧描述","model":"old/model","command":"/opt/example/omp"},"rules":{"report_lines":2},"custom":{"value":3}}\n';
	writeFileSync(path, before);
	const { ui, prefill } = questions(["分拣", "编辑", "完成"], ["example/model"]);
	const deps = { lark: unexpected, slack: unexpected };
	await expect(runSetup(ui, { path, deps })).resolves.toBe(true);
	expect(prefill).toEqual(["旧描述"]);
	expect(readConfig(path)).toEqual({
		triage: { about: "示例用户，负责示例项目", model: "example/model", command: "/opt/example/omp" },
		rules: { report_lines: 2 }, custom: { value: 3 },
	});
	const backups = readdirSync(dir).filter(file => file.startsWith("config.json.bak."));
	expect(backups).toHaveLength(1);
	expect(readFileSync(join(dir, backups[0]), "utf8")).toBe(before);

	const cancel = questions(["分拣", "关闭", "完成"]);
	cancel.ui.confirm = async () => false;
	await expect(runSetup(cancel.ui, { path, deps })).resolves.toBe(false);
	expect(readConfig(path).triage?.about).toBe("示例用户，负责示例项目");
	expect(readdirSync(dir).filter(file => file.startsWith("config.json.bak."))).toEqual(backups);

	await runSetup(questions(["分拣", "关闭", "完成"]).ui, { path, deps });
	expect(readConfig(path).triage).toBeUndefined();
}));

test("飞书账号独立开关机器人和补读，按目录绑定、解绑并提示授权", () => tempConfig(async (path, dir) => {
	const cwd = join(dir, "项目");
	const previous = join(dir, "旧项目");
	writeFileSync(path, JSON.stringify({
		feishu: { accounts: [{ profile: "旧账号", bot: false, poll: false }] },
		projects: { [previous]: { feishu: "旧账号" } },
		rules: { language: "中文" },
	}));
	const { ui, notices } = questions([
		"飞书", "[x] 旧账号", "移除", "[ ] 示例公司", "开启", "关闭",
		"[ ] 示例团队", "关闭", "开启", "完成",
		"项目绑定", "绑定 示例公司", "项目绑定", "绑定 示例团队", "完成",
	], ["", "../团队"]);
	const argsSeen: string[][] = [];
	const deps = {
		slack: unexpected,
		async lark(args: string[]) {
			argsSeen.push(args);
			if (args[0] === "profile") return [{ name: "示例公司" }, { name: "示例团队" }];
			return { identities: { user: { status: args[1] === "示例公司" ? "missing" : "ready" }, bot: { status: "ready" } } };
		},
	};
	await expect(runSetup(ui, { path, deps, cwd })).resolves.toBe(true);
	expect(argsSeen).toEqual([
		["profile", "list"],
		["--profile", "示例公司", "auth", "status", "--json"],
		["--profile", "示例团队", "auth", "status", "--json"],
	]);
	const cfg = readConfig(path);
	expect(hasFeishu(cfg)).toBe(true);
	expect(hasFeishu({ feishu: { accounts: [{ profile: "暂停", bot: false, poll: false }] } })).toBe(false);
	expect(cfg).toEqual({
		feishu: { accounts: [{ profile: "示例公司", bot: true, poll: false }, { profile: "示例团队", bot: false, poll: true }] },
		projects: { [cwd]: { feishu: "示例公司" }, [join(dir, "团队")]: { feishu: "示例团队" } },
		rules: { language: "中文" },
	});
	expect(notices).toContainEqual(expect.stringContaining("lark-cli --profile '示例公司' auth login --domain im,contact --scope search:message"));
	expect(notices).toContainEqual(expect.stringContaining("飞书补读、飞书机器人长连接"));
	await expect(runSetup(questions(["项目绑定", "解绑", "完成"], [""]).ui, { path, deps, cwd })).resolves.toBe(true);
	expect(readConfig(path).projects).toEqual({ [join(dir, "团队")]: { feishu: "示例团队" } });
}));

test("Slack 只存文件路径，从 API 识别用户和读取频道", () => tempConfig(async (path, dir) => {
	const user = join(dir, "user.json");
	const app = join(dir, "app-token");
	writeFileSync(user, '{"token":"xoxp-example"}');
	writeFileSync(app, "xapp-example\n");
	const { ui, notices } = questions(["Slack", "[ ] #example", "完成", "完成"], ["workspace", user, "token", app, "PROJ-12"]);
	const calls: string[] = [];
	await expect(runSetup(ui, { path, deps: {
		lark: unexpected,
		async slack(method, token, params) {
			expect(token).toBe("xoxp-example");
			calls.push(method);
			if (method === "auth.test") return { ok: true, user_id: "U123" };
			expect(params?.types).toBe("public_channel,private_channel");
			return { ok: true, channels: [{ id: "C123", name: "example" }] };
		},
	} })).resolves.toBe(true);
	expect(calls).toEqual(["auth.test", "users.conversations"]);
	expect(readConfig(path)).toEqual({ slack: {
		domain: "workspace", user_token: { file: user, json_key: "token" }, app_token: { file: app },
		me: "U123", channels: { C123: { name: "#example", line: "PROJ-12" } },
	} });
	expect(readFileSync(path, "utf8")).not.toMatch(/xoxp-|xapp-/);
	expect(notices).toContainEqual(expect.stringContaining("Slack 补读、实时推送"));
}));

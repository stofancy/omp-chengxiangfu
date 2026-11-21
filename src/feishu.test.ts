import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectProfile } from "./feishu";

test("目录绑定按完整目录边界取最长匹配", () => {
	const projects = { "/src/repo/feature": { feishu: "子项目" }, "/src/repo/": { feishu: "主项目" } };
	expect(projectProfile(projects, "/src/repo")).toBe("主项目");
	expect(projectProfile(projects, "/src/repo/feature/docs")).toBe("子项目");
	expect(projectProfile(projects, "/src/repo/feature-old")).toBe("主项目");
	expect(projectProfile(projects, "/src/repository")).toBeUndefined();
	expect(projectProfile({ "/": { feishu: "根目录" } }, "/src")).toBe("根目录");
});

test("飞书输入按账号认领、沿用输入记账，只回飞书触发的轮次并在已知单聊推送提问", () => {
	const root = mkdtempSync(join(tmpdir(), "dispatch-feishu-test-"));
	try {
		// 任务表和配置都在导入时确定目录，另开进程确保不会碰到本机数据或其他测试。
		const result = Bun.spawnSync([process.execPath, "-e", `
			import assert from "node:assert/strict";
			import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
			import { join } from "node:path";
			import install from "./index";
			import { CONFIG, FEISHU_OWNER_CHAT, HOME, OPERATOR_NEW, OPERATOR_CLAIMED } from "./paths";
			import { setOn } from "./switch";
			import { EVENTS, append, readTable } from "./table";

			const profile = "示例公司";
			const another = "示例团队";
			const cwd = join(HOME, "repo/main");
			const same = join(HOME, "repo/other");
			const other = join(HOME, "another");
			writeFileSync(CONFIG, JSON.stringify({ projects: { [cwd]: { feishu: profile }, [same]: { feishu: profile }, [other]: { feishu: another } } }));
			mkdirSync(OPERATOR_NEW, { recursive: true });
			for (const sid of ["main", "same", "other"]) setOn(sid, true);
			append({ kind: "input", sid: "same", cwd: same });
			append({ kind: "input", sid: "other", cwd: other });

			const handlers = new Map();
			const tools = new Map();
			const injected = [];
			const calls = [];
			const schema = { describe: () => schema, optional: () => schema };
			const zod = Object.fromEntries(["array", "enum", "number", "object", "string"].map(k => [k, () => schema]));
			install({
				zod, on: (event, callback) => handlers.set(event, callback),
				registerCommand() {}, registerTool: tool => tools.set(tool.name, tool),
				getSessionName: () => "调度", sendUserMessage: (...args) => injected.push(args),
			}, async (...args) => { calls.push(args); return { ok: true }; });
			let tick;
			let idle = false;
			const ctx = {
				cwd, isIdle: () => idle, sessionManager: { getSessionFile: () => "main.jsonl" },
				setInterval: fn => { tick = fn; }, ui: { notify() {} },
			};
			const fire = (event, data) => handlers.get(event)(data, ctx);
			const prepare = prompt => fire("before_agent_start", { prompt, reason: "prompt" });
			const finish = (text, content = [{ type: "text", text }]) => fire("message_end", { message: { role: "assistant", content } });
			const ask = text => tools.get("tasktable_ask").execute("id", { action: "open", checked: "任务表没有决定", text }, undefined, undefined, ctx);
			await fire("session_start", {});
			await ask("上线");
			await ask("删除");
			assert.deepEqual(calls, []);

			const event = { source: "feishu", profile, chat_id: "oc_private", chat_type: "p2p", chat_name: "", message_id: "om_private", text: "1 做 2 不做", link: "https://applink.feishu.cn/client/chat/open?openChatId=oc_private", at: "2026-01-01T00:00:00Z" };
			const privateFile = "1000000000000000000-feishu-om_private.json";
			const groupFile = "1000000000000000001-feishu-om_group.json";
			const otherFile = "1000000000000000002-feishu-om_foreign.json";
			writeFileSync(join(OPERATOR_NEW, privateFile), JSON.stringify(event));
			writeFileSync(join(OPERATOR_NEW, groupFile), JSON.stringify({ ...event, message_id: "om_group", text: "请看群里这事", chat_type: "group", chat_id: "oc_group", chat_name: "示例群" }));
			writeFileSync(join(OPERATOR_NEW, otherFile), JSON.stringify({ ...event, message_id: "om_foreign", profile: another }));
			await tick();
			assert.deepEqual(injected, [], "同账号最近发话的会话优先，其他账号不影响");

			await fire("input", { text: "终端发起" });
			await prepare("终端发起");
			await tick();
			assert.deepEqual(readdirSync(OPERATOR_NEW), [otherFile]);
			assert.deepEqual(readdirSync(OPERATOR_CLAIMED).sort(), [privateFile, groupFile]);
			assert.equal(injected.length, 2);
			assert.deepEqual(injected.map(([, options]) => options), [{ deliverAs: "followUp" }, { deliverAs: "followUp" }]);
			assert.match(injected[0][0], /私聊机器人.*\\]\\n1 做 2 不做/);
			assert.match(injected[1][0], /示例群.*openChatId=oc_group/);
			assert.equal(readTable().asks.size, 0, "来源说明不应妨碍编号自动记账");
			assert.deepEqual(readTable().decisions.map(e => e.text), ["上线 → 做", "删除 → 不做"]);
			const inputs = readFileSync(EVENTS, "utf8").trim().split("\\n").map(line => JSON.parse(line)).filter(e => e.kind === "input" && e.sid === "main");
			assert.equal(inputs.length, 3, "终端 1 条 + 飞书 2 条，各记一次");

			await finish("前一轮终端回复");
			assert.deepEqual(calls, [], "尚未交付的飞书输入不接收终端回复");
			const batch = injected.map(([text]) => text).join("\\n\\n");
			await prepare(batch);
			await prepare(batch);
			await finish("中间工具调用", [{ type: "toolCall" }]);
			assert.deepEqual(calls, []);
			await finish("飞书最终回复");
			assert.deepEqual(calls, [[[
				"--profile", profile, "im", "+messages-reply", "--as", "bot", "--message-id", "om_group", "--markdown", "-", "--format", "json",
			], "飞书最终回复"]]);
			await prepare("下一轮仍由终端发起");
			await finish("终端回复");
			assert.equal(calls.length, 1);

			assert.deepEqual(JSON.parse(readFileSync(FEISHU_OWNER_CHAT, "utf8")), { [profile]: "oc_private" });
			await ask("看下一条");
			assert.deepEqual(calls[1], [[
				"--profile", profile, "im", "+messages-send", "--as", "bot", "--chat-id", "oc_private", "--markdown", "-", "--format", "json",
			], "待你决定 #3：看下一条"]);

			idle = true;
			writeFileSync(join(OPERATOR_NEW, privateFile), JSON.stringify({ ...event, message_id: "om_idle", text: "空闲时直接发话" }));
			await tick();
			assert.equal(injected[2].length, 1, "空闲时不传 deliverAs");
		`], { cwd: import.meta.dir, env: { ...process.env, DISPATCH_DESK_HOME: root } });
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
	} finally {
		rmSync(root, { recursive: true });
	}
});

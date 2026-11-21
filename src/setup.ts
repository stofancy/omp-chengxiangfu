import { constants, copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FeishuAccount, FeishuConfig, Secret, SlackConfig } from "../sources/config";
import { type Lark, type Projects, runLark } from "./feishu";
import { CONFIG } from "./paths";
import { writeAtomic } from "./table";

export interface SetupUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

interface Group { name: string; line?: string }

interface DeskConfig extends Record<string, unknown> {
	feishu?: FeishuConfig;
	projects?: Projects;
	slack?: SlackConfig;
	triage?: { about?: string; model?: string; command?: string };
	ado?: { org?: string };
	reminders?: { file?: string };
}

interface SetupIO {
	lark: Lark;
	slack(method: string, token: string, params?: Record<string, string>): Promise<unknown>;
}

const io: SetupIO = {
	lark: runLark,
	async slack(method, token, params) {
		const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
			method: method === "auth.test" ? "POST" : "GET",
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) throw new Error(`Slack ${method}：HTTP ${res.status}`);
		return res.json();
	},
};

export function readConfig(path = CONFIG): DeskConfig {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

export const hasFeishu = (cfg: DeskConfig): boolean => !!cfg.feishu?.accounts?.some(account => account.bot || account.poll);

const DONE = "完成";
const BACK = "返回";

async function field(ui: SetupUI, title: string, current = ""): Promise<string | undefined> {
	const answer = await ui.input(current ? `${title}（留空保留 ${current}）` : title, current || undefined);
	return answer === undefined ? undefined : answer.trim() || current;
}

async function configureTriage(ui: SetupUI, cfg: DeskConfig) {
	const action = await ui.select("分拣设置", ["编辑", "关闭", BACK]);
	if (action === "关闭") {
		delete cfg.triage;
	} else if (action === "编辑") {
		const about = (await ui.editor("分拣描述：你在聊天中叫什么，团队做什么", cfg.triage?.about))?.trim();
		if (!about) return;
		const model = await field(ui, "分拣模型", cfg.triage?.model ?? "pi/smol");
		if (model !== undefined) cfg.triage = { ...cfg.triage, about, model };
	}
}

// 已选但这次没列出的频道仍可移除。
async function pickGroups(ui: SetupUI, title: string, available: Record<string, Group>, current: Record<string, Group> = {}) {
	const groups = { ...current };
	const entries = Object.entries({ ...current, ...available });
	for (;;) {
		const options = entries.map(([id, { name }]) => `${groups[id] ? "[x]" : "[ ]"} ${name} (${id})${groups[id]?.line ? ` → ${groups[id].line}` : ""}`);
		const choice = await ui.select(`${title}（选择切换勾选；重新勾选可改任务归属）`, [DONE, ...options]);
		if (choice === undefined || choice === DONE) return groups;
		const [id, { name }] = entries[options.indexOf(choice)];
		if (groups[id]) delete groups[id];
		else {
			const line = (await ui.input(`${name} 的任务名（可留空）`))?.trim();
			groups[id] = { name, ...(line ? { line } : {}) };
		}
	}
}

async function configureFeishu(ui: SetupUI, cfg: DeskConfig, lark: SetupIO["lark"]) {
	const profiles = (await lark(["profile", "list"])) as Array<{ name: string }>;
	const accounts = new Map((cfg.feishu?.accounts ?? []).map(account => [account.profile, account]));
	const names = [...new Set([...profiles.map(p => p.name), ...accounts.keys()])];
	for (;;) {
		const options = names.map(name => `${accounts.has(name) ? "[x]" : "[ ]"} ${name}`);
		const choice = await ui.select("飞书账号", [DONE, ...options]);
		if (choice === undefined || choice === DONE) break;
		const profile = names[options.indexOf(choice)];
		const current = accounts.get(profile);
		if (current) {
			const action = await ui.select(`飞书 · ${profile}`, ["编辑", "移除", BACK]);
			if (action === "移除") accounts.delete(profile);
			if (action !== "编辑") continue;
		}
		try {
			const account = await configureFeishuAccount(ui, lark, profile, current);
			if (account) accounts.set(profile, account);
		} catch (err) {
			ui.notify(String(err), "error");
		}
	}
	if (accounts.size || cfg.feishu) cfg.feishu = { accounts: [...accounts.values()] };
	for (const [path, binding] of Object.entries(cfg.projects ?? {})) {
		if (!accounts.has(binding.feishu)) delete cfg.projects?.[path];
	}
}

async function configureFeishuAccount(ui: SetupUI, lark: SetupIO["lark"], profile: string, current?: FeishuAccount) {
	const status = await lark(["--profile", profile, "auth", "status", "--json"]) as {
		identities?: { user?: { status: string }; bot?: { status: string } };
	};
	const user = status.identities?.user?.status;
	const bot = status.identities?.bot?.status;
	ui.notify(`飞书 · ${profile}：user ${user ?? "未知"}，bot ${bot ?? "未知"}`, "info");
	if (user !== "ready") {
		const quoted = `'${profile.replace(/'/g, "'\\''")}'`;
		ui.notify(`请先运行 lark-cli --profile ${quoted} auth login --domain im,contact --scope search:message`, "warning");
	}
	if (bot !== "ready") ui.notify(`飞书 · ${profile}：请在飞书开发者后台检查机器人配置`, "warning");
	const toggle = (title: string, enabled: boolean) => ui.select(`飞书 · ${profile} · ${title}`, enabled ? ["开启", "关闭"] : ["关闭", "开启"]);
	const botChoice = await toggle("机器人入口（长连接）", current?.bot ?? true);
	if (botChoice === undefined) return;
	const pollChoice = await toggle("用户身份补读", current?.poll ?? false);
	if (pollChoice === undefined) return;
	return { profile, bot: botChoice === "开启", poll: pollChoice === "开启" };
}

async function configureProject(ui: SetupUI, cfg: DeskConfig, cwd: string) {
	const dir = await field(ui, "项目目录", cwd);
	if (dir === undefined) return;
	const path = dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : resolve(cwd, dir);
	const profiles = (cfg.feishu?.accounts ?? []).map(account => account.profile);
	const current = cfg.projects?.[path]?.feishu;
	if (!profiles.length && !current) {
		ui.notify("请先添加飞书账号。", "warning");
		return;
	}
	const options = profiles.map(profile => `绑定 ${profile}`);
	const choice = await ui.select(`项目绑定 · ${path}${current ? ` · 当前 ${current}` : ""}`, [...options, ...(current ? ["解绑"] : []), BACK]);
	if (choice === "解绑") delete cfg.projects?.[path];
	else if (choice !== undefined && choice !== BACK) (cfg.projects ??= {})[path] = { feishu: profiles[options.indexOf(choice)] };
}

async function secretFile(ui: SetupUI, title: string, current?: Secret): Promise<Secret | undefined> {
	const file = await field(ui, `${title} token 文件路径（不要输入 token）`, current?.file);
	if (!file) return;
	const path = file.startsWith("~/") ? join(homedir(), file.slice(2)) : resolve(file);
	if (!existsSync(path)) throw new Error(`${title} token 文件不存在`);
	if (file === current?.file) return { ...current, file: path };
	if (!file.endsWith(".json")) return { file: path };
	const key = (await ui.input(`${title} token 在 JSON 里的字段名`))?.trim();
	return key ? { file: path, json_key: key } : undefined;
}

async function configureSlack(ui: SetupUI, cfg: DeskConfig, slack: SetupIO["slack"]) {
	const current = cfg.slack;
	const domain = await field(ui, "Slack 工作区子域（.slack.com 前面）", current?.domain);
	if (!domain) return;
	const user_token = await secretFile(ui, "Slack user", current?.user_token);
	if (!user_token) return;
	const app_token = await secretFile(ui, "Slack app", current?.app_token);
	if (!app_token) return;
	let token: string;
	try {
		const raw = readFileSync(user_token.file, "utf8");
		token = (user_token.json_key ? JSON.parse(raw)[user_token.json_key] : raw).trim();
	} catch {
		throw new Error("Slack user token 文件或 JSON 字段不可读");
	}
	const auth = await slack("auth.test", token) as { ok: boolean; user_id?: string; error?: string };
	if (!auth.ok || !auth.user_id) throw new Error(`Slack auth.test：${auth.error ?? "未返回用户 ID"}`);
	const available: Record<string, Group> = {};
	let cursor = "";
	do {
		const page = await slack("users.conversations", token, { types: "public_channel,private_channel", exclude_archived: "true", limit: "200", cursor }) as {
			ok: boolean; channels: Array<{ id: string; name: string }>; response_metadata?: { next_cursor?: string }; error?: string;
		};
		if (!page.ok) throw new Error(`Slack users.conversations：${page.error ?? "读取频道失败"}`);
		for (const c of page.channels) available[c.id] = { name: `#${c.name}` };
		cursor = page.response_metadata?.next_cursor ?? "";
	} while (cursor);
	const channels = await pickGroups(ui, "Slack · 要读的频道", available, current?.channels);
	if (channels) cfg.slack = { ...current, domain, user_token, app_token, me: auth.user_id, channels };
}

export async function runSetup(ui: SetupUI, { path = CONFIG, deps = io, cwd = process.cwd() } = {}): Promise<boolean> {
	const cfg = readConfig(path);
	const before = JSON.stringify(cfg);
	for (;;) {
		const choice = await ui.select("调度配置：选择要配置的部分", ["分拣", "飞书", "项目绑定", "Slack", DONE]);
		if (choice === undefined) return false;
		if (choice === DONE) break;
		try {
			if (choice === "分拣") await configureTriage(ui, cfg);
			else if (choice === "飞书") await configureFeishu(ui, cfg, deps.lark);
			else if (choice === "项目绑定") await configureProject(ui, cfg, cwd);
			else if (choice === "Slack") await configureSlack(ui, cfg, deps.slack);
		} catch (err) {
			ui.notify(String(err), "error");
		}
	}
	const changed = JSON.stringify(cfg) !== before;
	if (changed) {
		if (!(await ui.confirm("保存调度配置", `写入 ${path}；已有配置会先备份。`))) return false;
		let backup: string | undefined;
		if (existsSync(path)) {
			const base = `${path}.bak.${new Date().toISOString().replace(/:/g, "-")}`;
			backup = base;
			for (let n = 1; existsSync(backup); n++) backup = `${base}.${n}`;
			copyFileSync(path, backup, constants.COPYFILE_EXCL);
		}
		writeAtomic(path, `${JSON.stringify(cfg, null, 2)}\n`);
		ui.notify(backup ? `已保存配置；旧配置备份在 ${backup}` : `已保存配置：${path}`, "info");
	}
	const deploy = ["PR 补读"];
	if (cfg.reminders) deploy.push("到期提醒");
	if (cfg.slack) deploy.push("Slack 补读、实时推送");
	if (cfg.feishu?.accounts?.some(a => a.poll)) deploy.push("飞书补读");
	if (cfg.feishu?.accounts?.some(a => a.bot)) deploy.push("飞书机器人长连接");
	ui.notify(`需部署：${deploy.join("、")}。请在插件仓库运行 bun scripts/install.ts。`, "info");
	return changed;
}

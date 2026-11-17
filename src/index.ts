// omp-chengxiangfu：调度器模式。默认关；在会话里敲 /调度 打开，打开状态跟着会话走。关着的会话里，插件什么都不做。
//
// 派子代理、给子代理发消息、子代理再派人、续会话后叫醒子代理、看谁在跑，都是 omp 自带的，这里不重做。
// 插件只补 omp 没有的三样：
// - 一本全局的任务表（tasks/events.jsonl）：每个任务登记负责 agent 的名字（主会话用这个名字派出子代理，之后 agent://<名字> 就是它）和要盯的外部输入。
// - 每次请求末尾附规则（不写进会话历史，压缩丢不掉）：主会话收调度规则、常设约束和任务表摘要；任务的负责 agent 收常设约束、负责 agent 的规矩和任务卡；其他子代理只收常设约束。
// - 外部消息：会话外的程序写进 inbox/new；每 5 秒认领一次，按任务登记的「要盯的外部输入」归到任务，合成一条消息叫醒主会话，由它交给负责 agent。
// 远端写入自动记到任务表。不拦截任何操作。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { DISPATCH_RULES, HOME, INBOX_CLAIMED, INBOX_NEW, ORDERS, OWNER_RULES, USER_RULES } from "./paths";
import { remoteWrite } from "./remote";
import { checkReply, feedback, renderRules, settings } from "./rules";
import { OFF_MESSAGE, isOn, setOn } from "./switch";
import { type Ev, GENERAL, type Table, agentTaken, append, logError, openTasks, readTable, taskOfAgent, today } from "./table";
import { renderViews, since, snapshot, taskCard } from "./views";
import { matchTask } from "./watch";

const TICK_MS = 5_000;
const STATUS_KEY = "chengxiangfu";
const TOOLS = ["tasktable_task", "tasktable_update", "tasktable_ask", "tasktable_correction"];
// 一条编号回答：编号 + 可选标点 + 最多 4 个字的回答（「做」「不做」「先不」可以，「点以后再说」不行）
const ANSWER = /(?<!\d)(\d{1,3})\s*[.、:：)）]?\s*([^\s\d;；,，。.、:：]{1,4})(?=[\s;；,，。.、]|$)/g;

// 本机没有 omp 扩展的类型声明（运行时由 omp 解析），这里只声明用到的字段
interface Ctx {
	agent?: { kind?: string; id?: string };
	sessionManager?: { getSessionFile?(): string | undefined };
	getAsyncJobSnapshot?(): { running?: Array<{ id: string; label?: string }> } | null;
	setInterval(fn: () => void | Promise<void>, ms: number): unknown;
	ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
		setStatus?(key: string, text: string | undefined): void;
	};
}
interface InboxFile { source?: string; who?: string; where?: string; link?: string; line?: string; note?: string; urgent?: boolean }
interface UpdateParams { task?: string; id: string; title?: string; status?: string; next?: string; chase?: string; pr?: string; source?: string }
interface AskParams { action: "open" | "close" | "decide"; task?: string; text?: string; n?: number; outcome?: string }
interface TaskParams { task: string; agent?: string; title?: string; goal?: string; done_when?: string; watch_add?: string[]; watch_remove?: string[]; status?: string }
type Input = Record<string, unknown>;

// 子代理的会话文件在 <主会话>/<子代理>.jsonl，孙代理在 <主会话>/<子代理>/<子代理.孙代理>.jsonl：
// 按 id 的层数往上找，子孙都归到最顶上的主会话
function sessionOf(ctx: Ctx): string | undefined {
	const f = ctx.sessionManager?.getSessionFile?.();
	if (!f) return undefined;
	if (ctx.agent?.kind !== "sub") return basename(f, ".jsonl");
	let dir = dirname(f);
	for (let depth = (ctx.agent.id ?? "").split(".").length; depth > 1; depth--) dir = dirname(dir);
	return basename(dir);
}
const isMain = (ctx: Ctx) => ctx.agent?.kind !== "sub";
const on = (ctx: Ctx) => isOn(sessionOf(ctx)); // 子代理跟随它所属的主会话
const read = (path: string) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};

// 外部消息归到哪个任务：先按任务登记的「要盯的外部输入」；没命中再用消息源自带的归属（频道配置、PR 标题里的卡号），但只认任务表里未完成的任务
function route(l: Table, ev: InboxFile): { task?: string; tag: string } {
	const open = openTasks(l);
	const m = matchTask(ev, open.map(t => ({ name: t.name, watch: t.watch })));
	if (m.candidates.length) return { tag: `task=? (candidates: ${m.candidates.join(", ")})` };
	const name = m.task ?? (open.some(t => t.name === ev.line) ? ev.line : undefined);
	if (!name) return { tag: "task=?" };
	const agent = l.tasks.get(name)?.agent;
	return { task: name, tag: `task=${name} | owner=${agent ? `agent://${agent}` : "none"}` };
}

export default function (pi: ExtensionAPI): void {
	const z = pi.zod;
	let session: string | undefined;
	let ui: Ctx | undefined;
	let inboxSinceInput = 0;
	let urgentSinceInput = 0;
	const pending = new Map<string, string>(); // toolCallId → 远端写入摘要
	let replyNote: string | undefined; // 上一次回复的检查结果，下一次请求提醒模型
	let awayNote: string | undefined; // 用户离开一段时间后回来：这期间的变化
	let awayDelivered = false; // 离开提示已随用户那条消息交付，那一轮答完就清掉
	let userTurn = false; // 这一轮是用户发话引起的（不是外部事件叫醒的）：只有这种回复才算用户看过

	const record = (ev: Omit<Ev, "ts">) => {
		append(ev);
		renderViews();
	};
	const running = (ctx: Ctx) => (ctx.getAsyncJobSnapshot?.()?.running ?? []).map(j => (j.label ? `${j.id} (${j.label})` : j.id));

	const status = (ctx: Ctx): string => {
		const l = readTable();
		const parts = [`📋 任务 ${openTasks(l).length}`, `待你决定 ${l.asks.size}`, `在跑的 agent ${running(ctx).length}`, `新消息 ${inboxSinceInput}`];
		if (urgentSinceInput) parts.push(`其中私信/@你 ${urgentSinceInput}`); // 都是你上次发话以来到的，发话后清零
		return parts.join(" · ");
	};
	const showStatus = (ctx: Ctx) => ctx.ui.setStatus?.(STATUS_KEY, isOn(session) ? status(ctx) : undefined);

	// ---------- 外部消息：只交给打开了调度器模式、用户最近发话的会话；一拍内的合成一条消息 ----------

	const claimInbox = () => {
		if (!existsSync(INBOX_NEW)) return;
		const names = readdirSync(INBOX_NEW).filter((n: string) => n.endsWith(".json")).sort();
		if (!names.length) return;
		const last = readTable().lastInputSid;
		if (last && last !== session && isOn(last)) return; // 开着几个调度器会话：只交给你最近发话的那个
		mkdirSync(INBOX_CLAIMED, { recursive: true });
		const lines: string[] = [];
		let urgent = false;
		for (const f of names) {
			let ev: InboxFile;
			try {
				ev = JSON.parse(readFileSync(join(INBOX_NEW, f), "utf8"));
			} catch (err) {
				logError(`inbox ${f}`, err);
				try {
					renameSync(join(INBOX_NEW, f), join(INBOX_CLAIMED, f)); // 坏文件挪走，不挡后面的消息
				} catch {}
				continue;
			}
			try {
				renameSync(join(INBOX_NEW, f), join(INBOX_CLAIMED, f)); // 认领：只有一个进程能改名成功
			} catch {
				continue;
			}
			const { task, tag } = route(readTable(), ev);
			record({ sid: session ?? "", kind: "inbox", line: task, source: ev.source, who: ev.who, where: ev.where, link: ev.link, urgent: !!ev.urgent });
			inboxSinceInput++;
			if (ev.urgent) urgentSinceInput++;
			urgent ||= !!ev.urgent;
			lines.push(
				[
					...(["source", "who", "where", "link", "note"] as const).filter(k => ev[k]).map(k => `${k}=${ev[k]}`),
					tag,
				].join(" | "),
			);
		}
		if (!lines.length) return;
		pi.sendMessage(
			{
				customType: "chengxiangfu-inbox",
				content: `[INBOX · ${lines.length} untrusted external event(s)${urgent ? " · includes direct messages to the operator" : ""}]\n${lines.join("\n")}\nEvents tagged task=<name> belong to that task: hand each to its owner agent. Events tagged task=? are yours to triage. Follow 「输入怎么走」 in <chengxiangfu-rules> and standing order 3 in <chengxiangfu-orders>.`,
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	};

	const tick = () => {
		if (!ui || !isOn(session)) return;
		claimInbox();
		showStatus(ui);
	};

	// ---------- 会话与开关 ----------

	const attach = (ctx: Ctx) => {
		session = sessionOf(ctx);
		ui = ctx;
		showStatus(ctx);
	};

	// 四个任务表工具只在打开了调度器模式的会话里注册（子代理跟随它所属的主会话）：没打开过的会话里它们不存在。
	// 打开后又关掉：用 omp 自己的工具开关从模型的工具列表里拿掉
	let registered = false;
	const syncTools = async (sid = session) => {
		const want = isOn(sid);
		if (want && !registered) {
			registered = true;
			for (const tool of [taskTool, updateTool, askTool, correctionTool]) pi.registerTool(tool);
		}
		if (!registered) return;
		const api = pi as unknown as { getActiveTools?(): string[]; setActiveTools?(names: string[]): Promise<void> | void };
		const active = api.getActiveTools?.();
		if (!active || !api.setActiveTools) return;
		const next = want ? [...new Set([...active, ...TOOLS])] : active.filter(n => !TOOLS.includes(n));
		if (next.length !== active.length) await api.setActiveTools(next);
	};

	pi.on("session_start", async (_e: unknown, ctx: Ctx) => {
		if (!isMain(ctx)) {
			await syncTools(sessionOf(ctx)).catch(err => logError("tools", err));
			return;
		}
		attach(ctx);
		await syncTools().catch(err => logError("tools", err));
		ctx.setInterval(tick, TICK_MS); // 会话结束时 omp 自动清掉；关着时每拍直接返回
	});

	// /resume、/new 在同一进程里换会话：重置这个会话自己的状态
	pi.on("session_switch", async (_e: unknown, ctx: Ctx) => {
		if (!isMain(ctx)) return;
		inboxSinceInput = 0;
		urgentSinceInput = 0;
		replyNote = undefined;
		awayNote = undefined;
		awayDelivered = false;
		attach(ctx);
		await syncTools().catch(err => logError("tools", err));
	});

	pi.registerCommand("调度", {
		description: "打开调度器模式；/调度 off 关掉。打开状态跟着会话走，omp -r / -c 续上时不用再敲",
		handler: async (args: string, ctx: Ctx) => {
			if (!isMain(ctx)) return;
			attach(ctx);
			if (!session) {
				ctx.ui.notify("这个会话还没有会话文件，先发一条消息再打开调度器模式", "warning");
				return;
			}
			const off = /^(off|关|关闭)$/i.test(args.trim());
			setOn(session, !off);
			await syncTools().catch(err => logError("tools", err));
			showStatus(ctx);
			ctx.ui.notify(off ? "调度器模式已关闭：这个会话里插件不再做任何事" : "调度器模式已打开：你说的话和外部消息会按任务交给各自的负责 agent", "info");
		},
	});

	pi.on("input", async (e: { text?: string }, ctx: Ctx) => {
		if (!isMain(ctx) || !on(ctx)) return;
		const text = String(e.text ?? "");
		inboxSinceInput = 0; // 外部事件计数 = 用户上次发话以来到的
		urgentSinceInput = 0;
		// 离开多久从「上次发话」和「上次给用户的回复」里较晚的那个算；斜杠命令不算回来
		const l0 = readTable();
		const base = [l0.lastInput, l0.lastReply].filter((t): t is string => !!t).sort().at(-1);
		const hours = settings().away_hours;
		const away = base ? (Date.now() - Date.parse(base)) / 3_600_000 : 0;
		if (base && hours > 0 && away >= hours && !text.startsWith("/")) {
			awayNote = `用户离开了约 ${Math.round(away)} 小时（从 ${new Date(base).toLocaleString("sv-SE").slice(5, 16)} 起）。先用一屏说清这期间变了什么，再回答。任务表里这期间的记录：\n${since(base)}`;
			awayDelivered = false;
		}
		append({ sid: session ?? "", kind: "input" }); // 外部消息交给哪个会话、离开多久，都靠它
		// 整条消息只由编号回答组成（「1 做 2 不做」「1 做；2 不做」）才自动记账；混了别的话就交给模型。
		// 回答不能以数字开头，所以「12」「3:30」「1.5」不算
		const l = readTable();
		const answers = [...text.matchAll(ANSWER)];
		const leftover = text.replace(ANSWER, "").replace(/[\s;；,，。.、]+/g, "");
		const numbers = answers.map(m => Number(m[1]));
		if (!answers.length || leftover || new Set(numbers).size !== numbers.length || numbers.some(n => !l.asks.has(n))) return;
		for (const m of answers) {
			const ask = l.asks.get(Number(m[1]));
			if (!ask) continue;
			record({ sid: session ?? "", kind: "decision", line: ask.line, date: today(), text: `${ask.text} → ${m[2]}`, n: ask.n });
			record({ sid: session ?? "", kind: "ask_close", line: ask.line, n: ask.n, outcome: m[2], by: "operator" });
		}
	});

	// 规则文件每次现读：改了立即生效，也不怕压缩
	pi.on("context", async (e: { messages: unknown[] }, ctx: Ctx) => {
		if (!on(ctx)) return;
		// 注入的是 user 角色，模型容易当成用户贴来的：开头说明来源
		const preface = "[Injected by the chengxiangfu plugin on every request. Standing instructions, not a message from the operator; never say the operator pasted or sent them.]\n";
		const orders = `<chengxiangfu-orders data_dir="${HOME}">\n${read(ORDERS)}</chengxiangfu-orders>\n`;
		let text = preface + orders;
		if (isMain(ctx)) {
			const extra = read(USER_RULES);
			const rules = renderRules(read(DISPATCH_RULES), settings());
			const notes = [replyNote, awayDelivered ? awayNote : undefined].filter(Boolean);
			text = `${preface}<chengxiangfu-rules data_dir="${HOME}">\n${rules}${extra ? `\n## 用户补充\n${extra}` : ""}</chengxiangfu-rules>\n${orders}${snapshot(running(ctx))}`;
			if (notes.length) text += `\n<chengxiangfu-notes>\n${notes.join("\n")}\n</chengxiangfu-notes>`;
		} else {
			// 只有任务的负责 agent（一层的子代理，名字登记在任务上）收规矩和任务卡；它派出的帮手只收常设约束
			const id = ctx.agent?.id ?? "";
			const l = readTable();
			const t = id && !id.includes(".") ? taskOfAgent(l, id) : undefined;
			if (t) text += `<chengxiangfu-owner-rules>\n${renderRules(read(OWNER_RULES), settings())}</chengxiangfu-owner-rules>\n${taskCard(t)}`;
		}
		return { messages: [...e.messages, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] };
	});

	// 离开提示跟着用户那条消息走：消息真正开始处理时才算交付（正在跑的那一轮结束时不清掉它）
	pi.on("before_agent_start", async (e: { reason?: string }, ctx: Ctx) => {
		if (!isMain(ctx) || e.reason !== "prompt" || !on(ctx)) return;
		userTurn = true;
		if (awayNote) awayDelivered = true;
	});
	pi.on("agent_end", async (_e: unknown, ctx: Ctx) => {
		if (isMain(ctx)) userTurn = false;
	});

	// 回复的事后检查：只看主会话给用户的最后一条（不带工具调用的）回复，不拦截
	pi.on("message_end", async (e: { message?: { role?: string; stopReason?: string; content?: Array<{ type: string; text?: string }> } }, ctx: Ctx) => {
		const m = e.message;
		if (!isMain(ctx) || !on(ctx) || m?.role !== "assistant" || !Array.isArray(m.content)) return;
		if (m.stopReason === "aborted" || m.stopReason === "error" || m.content.some(b => b.type === "toolCall")) return;
		const text = m.content.filter(b => b.type === "text").map(b => b.text ?? "").join("\n").trim();
		if (!text) return;
		const l = readTable();
		const ids = new Set<string>(); // 负责 agent 的名字不算：规则要求提到它时说清它在做哪个任务
		for (const byTask of l.items.values()) for (const i of byTask.values()) ids.add(i.id);
		const result = checkReply(text, ids);
		replyNote = feedback(result, awayDelivered ? undefined : settings().report_lines); // 离开后的那一屏不算超长
		if (awayDelivered) {
			awayNote = undefined;
			awayDelivered = false;
		}
		// 回复时间只记回答用户的：外部事件叫醒的那一轮用户可能不在，不能算他看过
		if (userTurn || replyNote) append({ sid: session ?? "", kind: userTurn ? "reply" : "check", ...(replyNote ? { lines: result.lines, codes: result.codes } : {}) });
	});

	// ---------- 远端写入记账：用观测事件，不注册 tool_call/tool_result（注册了会关掉 omp 的子代理预启动） ----------

	pi.on("tool_execution_start", async (e: { toolCallId?: string; toolName: string; args?: Input }, ctx: Ctx) => {
		if (!on(ctx)) return;
		const summary = remoteWrite(e.toolName, e.args);
		if (summary && e.toolCallId) pending.set(e.toolCallId, summary);
	});
	pi.on("tool_execution_end", async (e: { toolCallId?: string; isError?: boolean }, ctx: Ctx) => {
		const summary = e.toolCallId ? pending.get(e.toolCallId) : undefined;
		const s = sessionOf(ctx);
		if (!summary || !s || !e.toolCallId) return;
		pending.delete(e.toolCallId);
		const by = isMain(ctx) ? "main" : (ctx.agent?.id ?? "subagent");
		record({ sid: s, kind: "action", line: by === "main" ? undefined : taskOfAgent(readTable(), by.split(".")[0])?.name, summary, ok: !e.isError, by });
	});

	// ---------- 任务表工具（调度器模式关着时报错） ----------

	const taskOr = (task: string | undefined) => task?.trim() || GENERAL;
	const sidOf = (ctx: Ctx) => {
		const s = sessionOf(ctx);
		if (!isOn(s)) throw new Error(OFF_MESSAGE);
		return s ?? "";
	};

	const taskTool = {
		name: "tasktable_task",
		label: "Task table task",
		description:
			"Create or update a task: its owner agent, goal, completion criteria and the external inputs it watches. Only the fields you pass are changed. A new task needs agent and done_when; after creating it, spawn the owner with the task tool using exactly that agent name, so agent://<name> is this task's owner. External events matching a watched link (Slack thread or channel, PR, ticket key) are routed to this task. Set status to 完成 to close it.",
		parameters: z.object({
			task: z.string().describe("Task name, e.g. a ticket key like PROJ-123 or a short name."),
			agent: z.string().optional().describe("Owner agent name, CamelCase ASCII (e.g. Proj123); unique among open tasks."),
			title: z.string().optional().describe("Short title the operator understands."),
			goal: z.string().optional().describe("What the task is for. No implementation plan."),
			done_when: z.string().optional().describe("Checkable completion criteria: commands, artifacts, links."),
			watch_add: z.array(z.string()).optional().describe("Links or identifiers to start watching."),
			watch_remove: z.array(z.string()).optional().describe("Links or identifiers to stop watching."),
			status: z.string().optional().describe("Leave empty while in progress; 完成 or 取消 closes the task."),
		}),
		async execute(_id: string, p: TaskParams, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const s = sidOf(ctx);
			const task = p.task.trim();
			if (!task || task === GENERAL) throw new Error("task name is required");
			const l = readTable();
			const agent = p.agent?.trim();
			if (agent && agentTaken(l, agent, task)) throw new Error(`owner agent name ${agent} is already used by another open task`);
			const isNew = !l.tasks.get(task)?.recorded;
			if (isNew && !agent) throw new Error("a new task needs agent");
			if (isNew && !p.done_when?.trim()) throw new Error("a new task needs done_when");
			const { task: _task, agent: _agent, ...rest } = p;
			const fields = Object.fromEntries(Object.entries({ ...rest, agent }).filter(([, v]) => (Array.isArray(v) ? v.length : typeof v === "string")));
			if (!Object.keys(fields).length) throw new Error("nothing to change");
			record({ sid: s, kind: "task", line: task, ...fields });
			return { content: [{ type: "text", text: isNew ? `created ${task}. Now spawn its owner with the task tool, name="${agent}".` : `updated ${task}` }] };
		},
	};

	const updateTool = {
		name: "tasktable_update",
		label: "Task table update",
		description: "Create or update one item (a step or sub-piece of work) inside a task. Call it whenever an item's status, next step, chase date or PR changes. Only the fields you pass are changed.",
		parameters: z.object({
			task: z.string().optional().describe(`Task name; use ${GENERAL} for things outside any task.`),
			id: z.string().describe("Item id inside the task, e.g. T6. A new id creates an item."),
			title: z.string().optional().describe("Short item name the operator understands (no codes)."),
			status: z.string().optional().describe("e.g. 进行中 / 等你 / 等别人（某某） / 完成"),
			next: z.string().optional().describe("Next step, and for waiting items where the reply will come from."),
			chase: z.string().optional().describe("Chase date YYYY-MM-DD for waiting items."),
			pr: z.string().optional().describe("PR link once one exists."),
			source: z.string().optional().describe("Evidence link or place."),
		}),
		async execute(_id: string, p: UpdateParams, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const s = sidOf(ctx);
			const line = taskOr(p.task);
			const { task: _task, ...fields } = p;
			record({ sid: s, kind: "item", line, ...fields });
			return { content: [{ type: "text", text: `recorded ${line}/${p.id}` }] };
		},
	};

	const askTool = {
		name: "tasktable_ask",
		label: "Task table ask",
		description:
			"Questions and decisions for the operator. action=open registers a question and returns its number (use that number when asking). action=close closes a question that became moot. action=decide records a decision the operator stated in prose; pass n when it answers an open question, which also closes it. Replies made only of numbered answers like '1 做 2 不做' are recorded automatically; do not record them again.",
		parameters: z.object({
			action: z.enum(["open", "close", "decide"]),
			task: z.string().optional().describe(`Task name; defaults to ${GENERAL}.`),
			text: z.string().optional().describe("open: the question, answerable in 1-2 words. decide: the decision in the operator's terms."),
			n: z.number().optional().describe("close: question number. decide: the question this decision answers, if any."),
			outcome: z.string().optional().describe("close: answer or why it is moot."),
		}),
		async execute(_id: string, p: AskParams, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const s = sidOf(ctx);
			const line = taskOr(p.task);
			if (p.action === "close") {
				if (p.n === undefined || !readTable().asks.has(p.n)) throw new Error(`no open question ${p.n}`);
				record({ sid: s, kind: "ask_close", line, n: p.n, outcome: p.outcome ?? "", by: "model" });
				return { content: [{ type: "text", text: `closed ${p.n}` }] };
			}
			if (!p.text) throw new Error("text is required");
			if (p.action === "open") {
				const n = readTable().lastAsk + 1;
				record({ sid: s, kind: "ask", line, n, text: p.text });
				return { content: [{ type: "text", text: `question number ${n}` }] };
			}
			record({ sid: s, kind: "decision", line, date: today(), text: p.text, ...(p.n === undefined ? {} : { n: p.n }) });
			if (p.n !== undefined && readTable().asks.has(p.n)) record({ sid: s, kind: "ask_close", line, n: p.n, outcome: p.text, by: "operator" });
			return { content: [{ type: "text", text: "decision recorded" }] };
		},
	};

	const correctionTool = {
		name: "tasktable_correction",
		label: "Task table correction",
		description:
			"action=record: the operator corrected you; record what was wrong in their terms and get a number back. Then propose in your report one rule line for <data_dir>/rules.md that would prevent it. action=close with n: after the operator agreed (and you wrote the rule) or declined. Open corrections stay in the task table context until closed.",
		parameters: z.object({
			action: z.enum(["record", "close"]),
			task: z.string().optional().describe(`Task name; defaults to ${GENERAL}.`),
			text: z.string().optional().describe("record: what was corrected, quoting the operator where possible."),
			n: z.number().optional().describe("close: correction number."),
			outcome: z.string().optional().describe("close: rule written, or declined."),
		}),
		async execute(_id: string, p: { action: "record" | "close"; task?: string; text?: string; n?: number; outcome?: string }, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const s = sidOf(ctx);
			const line = taskOr(p.task);
			if (p.action === "close") {
				if (p.n === undefined || !readTable().corrections.has(p.n)) throw new Error(`no open correction ${p.n}`);
				record({ sid: s, kind: "correction_close", line, n: p.n, outcome: p.outcome ?? "" });
				return { content: [{ type: "text", text: `closed correction ${p.n}` }] };
			}
			if (!p.text) throw new Error("text is required");
			const n = readTable().lastCorrection + 1;
			record({ sid: s, kind: "correction", line, n, text: p.text });
			return { content: [{ type: "text", text: `correction number ${n}` }] };
		},
	};
}

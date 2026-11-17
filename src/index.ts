// omp-chengxiangfu：装上插件，每个 omp 主会话就是一个调度器。不想用就卸载插件。
//
// - 每个会话默认用一个新账本；/bind 改用一个已有的账本。
// - 每次请求末尾附调度规则、常设约束和账本摘要（不写进会话历史，压缩丢不掉）；子代理只附常设约束。
// - 远端写入、外部消息自动记账。不拦截任何操作：约束靠常设约束。
// - 外部消息由会话外的程序写进 inbox/new；每 5 秒按线路由认领一次，合成一条消息叫醒调度器。
import { mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { bind, courtOf, courts, route, setCourtName } from "./court";
import { type Ev, GENERAL, append, logError, openLines, readLedger, today } from "./ledger";
import { DISPATCH_RULES, HOME, INBOX_CLAIMED, INBOX_NEW, ORDERS, USER_RULES } from "./paths";
import { remoteWrite } from "./remote";
import { checkReply, feedback, renderRules, settings } from "./rules";
import { renderViews, since, snapshot } from "./views";

const TICK_MS = 5_000;
const STATUS_KEY = "chengxiangfu";
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
		select?(title: string, options: string[]): Promise<string | undefined>;
		setStatus?(key: string, text: string | undefined): void;
	};
}
interface InboxFile { source?: string; who?: string; where?: string; link?: string; line?: string; note?: string; urgent?: boolean }
interface UpdateParams { line?: string; id: string; title?: string; status?: string; owner?: string; next?: string; chase?: string; pr?: string; source?: string }
interface AskParams { action: "open" | "close" | "decide"; line?: string; text?: string; n?: number; outcome?: string }
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
const read = (path: string) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};

// 负责人以卡号命名（PROJ-123 → Proj123），所以按名字把子代理的远端写入归到线上；主会话的动作不归线
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function lineOfAgent(court: string, by: string): string | undefined {
	const top = squash(by.split(".")[0]);
	const hits = [...openLines(readLedger(court))].filter(l => squash(l) === top);
	return hits.length === 1 ? hits[0] : undefined;
}

export default function (pi: ExtensionAPI): void {
	const z = pi.zod;
	let session: string | undefined;
	let ui: Ctx | undefined;
	let inboxSinceInput = 0;
	let urgentSinceInput = 0;
	let named = ""; // 上次写进账本名的会话标题
	// 接上别的账本的会话，标题用那个账本的名字（omp 会按第一句话自动起标题，跟账本对不上）
	const syncTitle = async () => {
		const c = court();
		if (!c || c === session) return;
		const name = courts().find(x => x.id === c)?.name;
		if (name && pi.getSessionName() !== name) await pi.setSessionName(name);
	};
	const pending = new Map<string, string>(); // toolCallId → 远端写入摘要
	let replyNote: string | undefined; // 上一次回复的检查结果，下一次请求提醒模型
	let awayNote: string | undefined; // 用户离开一段时间后回来：这期间的变化
	let awayDelivered = false; // 离开提示已随用户那条消息交付，那一轮答完就清掉
	let userTurn = false; // 这一轮是用户发话引起的（不是外部事件叫醒的）：只有这种回复才算用户看过

	const court = () => (session ? courtOf(session) : undefined);
	const record = (c: string, ev: Omit<Ev, "ts">) => {
		append(c, ev);
		renderViews(c);
	};
	const running = (ctx: Ctx) => (ctx.getAsyncJobSnapshot?.()?.running ?? []).map(j => (j.label ? `${j.id} (${j.label})` : j.id));

	const status = (ctx: Ctx): string | undefined => {
		const c = court();
		if (!c) return undefined;
		const l = readLedger(c);
		const parts = ["📋 调度", `进行中的线 ${openLines(l).size}`, `待你决定 ${l.asks.size}`, `子代理在跑 ${running(ctx).length}`, `新消息 ${inboxSinceInput}`];
		if (urgentSinceInput) parts.push(`其中私信/@你 ${urgentSinceInput}`); // 都是你上次发话以来到的，发话后清零
		return parts.join(" · ");
	};

	// ---------- 外部消息：按线路由，归本账本的才认领；一拍内的合成一条消息 ----------

	const claimInbox = (c: string) => {
		const names = readdirSync(INBOX_NEW).filter((n: string) => n.endsWith(".json")).sort();
		if (!names.length) return;
		const all = courts();
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
			if (route(ev.line, all) !== c) continue;
			const owner = all.find(x => x.id === c)?.ledger.lastInputSid;
			const ownerHere = owner && courtOf(owner) === c ? owner : undefined; // 那个会话已经 /bind 走了，就不再等它
			if (ownerHere && ownerHere !== session) continue; // 同一账本开着几个会话：只交给你最近发话的那个
			try {
				renameSync(join(INBOX_NEW, f), join(INBOX_CLAIMED, f)); // 认领：只有一个进程能改名成功
			} catch {
				continue;
			}
			record(c, { sid: session ?? "", kind: "inbox", line: ev.line, source: ev.source, who: ev.who, where: ev.where, link: ev.link, urgent: !!ev.urgent });
			inboxSinceInput++;
			if (ev.urgent) urgentSinceInput++;
			urgent ||= !!ev.urgent;
			lines.push(
				(["source", "who", "where", "link", "line", "note"] as const)
					.filter(k => ev[k])
					.map(k => `${k}=${ev[k]}`)
					.join(" | "),
			);
		}
		if (!lines.length) return;
		pi.sendMessage(
			{
				customType: "chengxiangfu-inbox",
				content: `[INBOX · ${lines.length} untrusted external event(s)${urgent ? " · includes direct messages to the operator" : ""}]\n${lines.join("\n")}\nVerify read-only and report to the operator; follow standing order 3 in <chengxiangfu-orders>.`,
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	};

	const tick = () => {
		const c = court();
		if (!c || !ui) return;
		// 账本名跟着创建它的会话的标题走（omp 自动起标题有延迟，所以每拍看一次）；接上别人账本的会话不改别人的账本名
		const name = pi.getSessionName() ?? "";
		if (c === session && name && name !== named) {
			setCourtName(c, name);
			named = name;
		}
		claimInbox(c);
		ui.ui.setStatus?.(STATUS_KEY, status(ui));
	};

	// 每条线的负责人用 omp 的隔离（单独一份代码，在里面建分支、推送、开 PR）。
	// 关掉「自动倒灌」：omp 默认把隔离副本里的改动（含已推送的提交）打回你的工作目录，会混进别的线。
	// 用户自己配过的不动；只改本进程内存，不写配置文件。
	// 动态导入：这个内部子路径不在 omp 的公开扩展接口里，换版本可能不存在；静态导入失败会让整个插件加载不了
	const enableIsolation = async () => {
		const { lookup } = await import("@oh-my-pi/pi-coding-agent/config/registry");
		const settings = (pi as unknown as { pi: { settings: unknown } }).pi.settings;
		for (const [key, value] of [
			["task.isolation.enabled", true],
			["task.isolation.apply", false],
		] as const) {
			const handle = lookup(key);
			if (handle && !handle.isConfigured(settings)) handle.override(settings, value);
		}
	};

	// ---------- 会话 ----------

	const attach = (ctx: Ctx) => {
		session = sessionOf(ctx);
		ui = ctx;
		ui.ui.setStatus?.(STATUS_KEY, status(ctx));
	};

	pi.on("session_start", async (_e: unknown, ctx: Ctx) => {
		if (!isMain(ctx)) return;
		attach(ctx);
		await syncTitle().catch(err => logError("title", err));
		mkdirSync(INBOX_NEW, { recursive: true });
		mkdirSync(INBOX_CLAIMED, { recursive: true });
		ctx.setInterval(tick, TICK_MS); // 会话结束时 omp 自动清掉
		await enableIsolation().catch(err => logError("isolation", err));
	});

	// /resume、/new 在同一进程里换会话：换成新会话的账本
	pi.on("session_switch", async (_e: unknown, ctx: Ctx) => {
		if (!isMain(ctx)) return;
		inboxSinceInput = 0;
		named = "";
		urgentSinceInput = 0;
		replyNote = undefined;
		awayNote = undefined;
		awayDelivered = false;
		attach(ctx);
		await syncTitle().catch(err => logError("title", err));
	});

	pi.on("input", async (e: { text?: string }, ctx: Ctx) => {
		const c = court();
		if (!isMain(ctx) || !c) return;
		const text = String(e.text ?? "");
		inboxSinceInput = 0; // 外部事件计数 = 用户上次发话以来到的
		urgentSinceInput = 0;
		// 离开多久从「上次发话」和「上次给用户的回复」里较晚的那个算；斜杠命令不算回来
		const l0 = readLedger(c);
		const base = [l0.lastInput, l0.lastReply].filter((t): t is string => !!t).sort().at(-1);
		const hours = settings().away_hours;
		const away = base ? (Date.now() - Date.parse(base)) / 3_600_000 : 0;
		if (base && hours > 0 && away >= hours && !text.startsWith("/")) {
			awayNote = `用户离开了约 ${Math.round(away)} 小时（从 ${new Date(base).toLocaleString("sv-SE").slice(5, 16)} 起）。先用一屏说清这期间变了什么，再回答。账本里这期间的记录：\n${since(c, base)}`;
			awayDelivered = false;
		}
		append(c, { sid: session ?? "", kind: "input", chars: text.length }); // 也是「每个 PR 花用户多少注意力」的原始数据
		// 整条消息只由编号回答组成（「1 做 2 不做」「1 做；2 不做」）才自动记账；混了别的话就交给模型。
		// 回答不能以数字开头，所以「12」「3:30」「1.5」不算
		const l = readLedger(c);
		const answers = [...text.matchAll(ANSWER)];
		const leftover = text.replace(ANSWER, "").replace(/[\s;；,，。.、]+/g, "");
		const numbers = answers.map(m => Number(m[1]));
		if (!answers.length || leftover || new Set(numbers).size !== numbers.length || numbers.some(n => !l.asks.has(n))) return;
		for (const m of answers) {
			const ask = l.asks.get(Number(m[1]));
			if (!ask) continue;
			record(c, { sid: session ?? "", kind: "decision", line: ask.line, date: today(), text: `${ask.text} → ${m[2]}`, n: ask.n });
			record(c, { sid: session ?? "", kind: "ask_close", line: ask.line, n: ask.n, outcome: m[2], by: "operator" });
		}
	});

	// 规则文件每次现读：改了立即生效，也不怕压缩。子代理只收常设约束
	pi.on("context", async (e: { messages: unknown[] }, ctx: Ctx) => {
		const s = sessionOf(ctx);
		if (!s) return;
		// 注入的是 user 角色，模型容易当成用户贴来的：开头说明来源
		const preface = "[Injected by the chengxiangfu plugin on every request. Standing instructions, not a message from the operator; never say the operator pasted or sent them.]\n";
		const orders = `<chengxiangfu-orders data_dir="${HOME}">\n${read(ORDERS)}</chengxiangfu-orders>\n`;
		let text = preface + orders;
		if (isMain(ctx)) {
			const extra = read(USER_RULES);
			const rules = renderRules(read(DISPATCH_RULES), settings());
			const notes = [replyNote, awayDelivered ? awayNote : undefined].filter(Boolean);
			text = `${preface}<chengxiangfu-rules data_dir="${HOME}">\n${rules}${extra ? `\n## 用户补充\n${extra}` : ""}</chengxiangfu-rules>\n${orders}${snapshot(courtOf(s), running(ctx))}`;
			if (notes.length) text += `\n<chengxiangfu-notes>\n${notes.join("\n")}\n</chengxiangfu-notes>`;
		}
		return { messages: [...e.messages, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] };
	});

	// 离开提示跟着用户那条消息走：消息真正开始处理时才算交付（正在跑的那一轮结束时不清掉它）
	pi.on("before_agent_start", async (e: { reason?: string }, ctx: Ctx) => {
		if (!isMain(ctx) || e.reason !== "prompt") return;
		userTurn = true;
		if (awayNote) awayDelivered = true;
	});
	pi.on("agent_end", async (_e: unknown, ctx: Ctx) => {
		if (isMain(ctx)) userTurn = false;
	});

	// 回复的事后检查：只看主会话给用户的最后一条（不带工具调用的）回复，不拦截
	pi.on("message_end", async (e: { message?: { role?: string; stopReason?: string; content?: Array<{ type: string; text?: string }> } }, ctx: Ctx) => {
		const m = e.message;
		const c = court();
		if (!isMain(ctx) || !c || m?.role !== "assistant" || !Array.isArray(m.content)) return;
		if (m.stopReason === "aborted" || m.stopReason === "error" || m.content.some(b => b.type === "toolCall")) return;
		const text = m.content.filter(b => b.type === "text").map(b => b.text ?? "").join("\n").trim();
		if (!text) return;
		const l = readLedger(c);
		const ids = new Set<string>(); // 负责人名字不算：规则要求提到它时说清它在做哪件事
		for (const byLine of l.items.values()) for (const i of byLine.values()) ids.add(i.id);
		const result = checkReply(text, ids);
		replyNote = feedback(result, awayDelivered ? undefined : settings().report_lines); // 离开后的那一屏不算超长
		if (awayDelivered) {
			awayNote = undefined;
			awayDelivered = false;
		}
		// 回复时间只记回答用户的：外部事件叫醒的那一轮用户可能不在，不能算他看过
		if (userTurn || replyNote) append(c, { sid: session ?? "", kind: userTurn ? "reply" : "check", ...(replyNote ? { lines: result.lines, codes: result.codes } : {}) });
	});

	// 远端写入记账：用观测事件，不注册 tool_call/tool_result（注册了会关掉 omp 的子代理预启动）
	pi.on("tool_execution_start", async (e: { toolCallId?: string; toolName: string; args?: Input }) => {
		const summary = remoteWrite(e.toolName, e.args);
		if (summary && e.toolCallId) pending.set(e.toolCallId, summary);
	});
	pi.on("tool_execution_end", async (e: { toolCallId?: string; isError?: boolean }, ctx: Ctx) => {
		const summary = e.toolCallId ? pending.get(e.toolCallId) : undefined;
		const s = sessionOf(ctx);
		if (!summary || !s || !e.toolCallId) return;
		pending.delete(e.toolCallId);
		const c = courtOf(s);
		const by = isMain(ctx) ? "main" : (ctx.agent?.id ?? "subagent");
		record(c, { sid: s, kind: "action", line: lineOfAgent(c, by), summary, ok: !e.isError, by });
	});

	pi.registerCommand("bind", {
		description: "本会话接上一个已有的账本（线、待定的事、已定的事）",
		handler: async (_args: string, ctx: Ctx) => {
			if (!isMain(ctx) || !session) return;
			const current = court();
			const options = courts()
				.filter(c => c.id === session || c.ledger.items.size || c.ledger.asks.size || c.ledger.decisions.length)
				.sort((a, b) => (b.ledger.lastInput ?? "").localeCompare(a.ledger.lastInput ?? ""))
				.map(c => {
					const lines = [...openLines(c.ledger)].join("、") || "无进行中的线";
					const mark = c.id === current ? "（当前）" : c.id === session ? "（本会话自己的）" : "";
					return { id: c.id, label: `${c.name}${mark} · ${lines} · 待定 ${c.ledger.asks.size}` };
				});
			if (!options.some(o => o.id === session)) options.push({ id: session, label: "本会话自己的账本（空）" });
			const picked = await ctx.ui.select?.("接上哪个账本？", options.map(o => o.label));
			const target = options.find(o => o.label === picked)?.id;
			if (!target || target === current) return;
			bind(session, target);
			renderViews(target);
			awayNote = undefined;
			awayDelivered = false;
			const l = readLedger(target);
			await syncTitle();
			const name = courts().find(c => c.id === target)?.name ?? target;
			ctx.ui.notify(`已接上「${name}」：进行中的线 ${openLines(l).size}，待你决定 ${l.asks.size}`, "info");
			ctx.ui.setStatus?.(STATUS_KEY, status(ctx));
		},
	});

	// ---------- 账本工具 ----------

	const lineOf = (line: string | undefined) => line?.trim() || GENERAL;
	const courtFor = (ctx: Ctx) => {
		const s = sessionOf(ctx);
		if (!s) throw new Error("this session has no session file, so it has no ledger");
		return { s, c: courtOf(s) };
	};

	pi.registerTool({
		name: "ledger_update",
		label: "Ledger update",
		description: "Create or update one task in this court's ledger. Call it whenever a task's status, owner, next step, chase date or PR changes. Only the fields you pass are changed.",
		parameters: z.object({
			line: z.string().optional().describe(`Line name, e.g. a ticket key like PROJ-123; use ${GENERAL} for things outside any line.`),
			id: z.string().describe("Task id inside the line, e.g. T6. A new id creates a task."),
			title: z.string().optional().describe("Short task name the operator understands (no codes)."),
			status: z.string().optional().describe("e.g. 进行中 / 等你 / 等别人（某某） / 完成"),
			owner: z.string().optional(),
			next: z.string().optional().describe("Next step, and for waiting tasks where the reply will come from."),
			chase: z.string().optional().describe("Chase date YYYY-MM-DD for waiting tasks."),
			pr: z.string().optional().describe("PR link once one exists."),
			source: z.string().optional().describe("Evidence link or place."),
		}),
		async execute(_id: string, p: UpdateParams, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const { s, c } = courtFor(ctx);
			const line = lineOf(p.line);
			const { line: _line, ...fields } = p;
			record(c, { sid: s, kind: "item", line, ...fields });
			return { content: [{ type: "text", text: `recorded ${line}/${p.id}` }] };
		},
	});

	pi.registerTool({
		name: "ledger_ask",
		label: "Ledger ask",
		description:
			"Questions and decisions for the operator. action=open registers a question and returns its number (use that number when asking). action=close closes a question that became moot. action=decide records a decision the operator stated in prose; pass n when it answers an open question, which also closes it. Replies made only of numbered answers like '1 做 2 不做' are recorded automatically; do not record them again.",
		parameters: z.object({
			action: z.enum(["open", "close", "decide"]),
			line: z.string().optional().describe(`Line name; defaults to ${GENERAL}.`),
			text: z.string().optional().describe("open: the question, answerable in 1-2 words. decide: the decision in the operator's terms."),
			n: z.number().optional().describe("close: question number. decide: the question this decision answers, if any."),
			outcome: z.string().optional().describe("close: answer or why it is moot."),
		}),
		async execute(_id: string, p: AskParams, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const { s, c } = courtFor(ctx);
			const line = lineOf(p.line);
			if (p.action === "close") {
				if (p.n === undefined || !readLedger(c).asks.has(p.n)) throw new Error(`no open question ${p.n}`);
				record(c, { sid: s, kind: "ask_close", line, n: p.n, outcome: p.outcome ?? "", by: "model" });
				return { content: [{ type: "text", text: `closed ${p.n}` }] };
			}
			if (!p.text) throw new Error("text is required");
			if (p.action === "open") {
				const n = readLedger(c).lastAsk + 1;
				record(c, { sid: s, kind: "ask", line, n, text: p.text });
				return { content: [{ type: "text", text: `question number ${n}` }] };
			}
			record(c, { sid: s, kind: "decision", line, date: today(), text: p.text, ...(p.n === undefined ? {} : { n: p.n }) });
			if (p.n !== undefined && readLedger(c).asks.has(p.n)) record(c, { sid: s, kind: "ask_close", line, n: p.n, outcome: p.text, by: "operator" });
			return { content: [{ type: "text", text: "decision recorded" }] };
		},
	});

	pi.registerTool({
		name: "ledger_correction",
		label: "Ledger correction",
		description:
			"action=record: the operator corrected you; record what was wrong in their terms and get a number back. Then propose in your report one rule line for <data_dir>/rules.md that would prevent it. action=close with n: after the operator agreed (and you wrote the rule) or declined. Open corrections stay in the ledger context until closed.",
		parameters: z.object({
			action: z.enum(["record", "close"]),
			line: z.string().optional().describe(`Line name; defaults to ${GENERAL}.`),
			text: z.string().optional().describe("record: what was corrected, quoting the operator where possible."),
			n: z.number().optional().describe("close: correction number."),
			outcome: z.string().optional().describe("close: rule written, or declined."),
		}),
		async execute(_id: string, p: { action: "record" | "close"; line?: string; text?: string; n?: number; outcome?: string }, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const { s, c } = courtFor(ctx);
			const line = lineOf(p.line);
			if (p.action === "close") {
				if (p.n === undefined || !readLedger(c).corrections.has(p.n)) throw new Error(`no open correction ${p.n}`);
				record(c, { sid: s, kind: "correction_close", line, n: p.n, outcome: p.outcome ?? "" });
				return { content: [{ type: "text", text: `closed correction ${p.n}` }] };
			}
			if (!p.text) throw new Error("text is required");
			const n = readLedger(c).lastCorrection + 1;
			record(c, { sid: s, kind: "correction", line, n, text: p.text });
			return { content: [{ type: "text", text: `correction number ${n}` }] };
		},
	});
}

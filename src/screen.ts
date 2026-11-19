// 屏幕上给用户看的东西，和主会话自己看不到的子代理状态：
// - 每条回复上方的标头（heads.ts 出文字，这里记住哪条回复画哪一行）；
// - 输入框上方的固定区：等用户定的事、在跑的负责 agent、接收程序的故障；
// - 子代理写好了却被 omp 压着的交回、久未交回的子代理：由这里叫醒主会话（agents.ts）。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Step, dueHandbacks, lastStep } from "./agents";
import { type Trigger, headLabel, headLine, rowFor, tailTriggers } from "./heads";
import { type Fault, faults, readHealth } from "./health";
import { CONFIG, HEADS, HELD, WATCH_PLAN } from "./paths";
import { settings } from "./rules";
import { type Table, logError, openTasks, ownerOfReviewer, readTable, writeAtomic } from "./table";
import type { Monitoring } from "./views";
import { type Sources, observed, watchPlan } from "./watch";

const WIDGET_KEY = "chengxiangfu";
const HELD_GRACE_MS = 15_000; // 子代理写完交回后这么久 omp 还没送，就由程序送
const HEADS_KEPT = 400;
const ASKS_SHOWN = 4;

interface Job { id: string; type?: string; agentId?: string; startTime?: number }
interface Ui {
	setWidget?(key: string, lines: string[] | undefined, options?: { placement: "aboveEditor" | "belowEditor" }): void;
	rerenderMessage?(timestamp: number): void;
}
interface Message { customType: string; content: string; display: boolean; attribution: "agent" }
export interface ScreenDeps {
	on(): boolean; // 这个主会话开着调度器模式
	session(): string | undefined;
	sessionDir(): string | undefined; // 主会话的子代理会话文件所在目录
	userTurn(): boolean; // 这一轮是用户发话引起的
	send(message: Message): void; // 给主会话送一条消息并叫醒它
}

const width = (s: string): number => (globalThis as { Bun?: { stringWidth(s: string): number } }).Bun?.stringWidth(s) ?? s.length;
const cols = () => process.stdout.columns ?? 100;
function clipTo(s: string, max: number): string {
	if (width(s) <= max) return s;
	let out = s;
	while (out.length > 1 && width(out) > max - 1) out = out.slice(0, -1);
	return `${out}…`;
}
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));
const span = (min: number) => (min < 60 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ""}`);

// 插件自己送进会话的消息（外部消息、被压着的交回、久未交回）在屏幕上画成一行；展开（omp 的展开键）才显示给模型看的原文。
// omp 的界面组件只要求有 render(宽度)，这里不依赖它的组件库
export function messageRow(message: { customType?: string; content?: unknown }, options?: { expanded?: boolean }) {
	const content = typeof message.content === "string" ? message.content : "";
	const row = rowFor(readTable(), message.customType ?? "", content) ?? content.split("\n")[0];
	return {
		render(max: number): string[] {
			const room = Math.max(20, max - 2);
			const lines = [` ${clipTo(row, room)}`];
			if (!options?.expanded) return lines;
			for (const raw of content.split("\n")) {
				let rest = raw;
				while (width(rest) > room) {
					let cut = rest.length;
					while (cut > 1 && width(rest.slice(0, cut)) > room) cut--;
					lines.push(`   ${rest.slice(0, cut)}`);
					rest = rest.slice(cut);
				}
				lines.push(`   ${rest}`);
			}
			return lines;
		},
		isTranscriptBlockCompact: () => !options?.expanded,
	};
}

// 本机配了哪些接收程序
export function sources(): Sources {
	try {
		const cfg = JSON.parse(readFileSync(CONFIG, "utf8")) as { slack?: unknown; ado?: { org?: string } };
		return { slack: !!cfg.slack, ado: cfg.ado?.org };
	} catch {
		return { slack: false };
	}
}

// 子代理是哪个任务的：负责 agent 或审查者；都不是返回 undefined
function taskOfJob(l: Table, agent: string): string | undefined {
	const named = (name: string) => openTasks(l).find(t => t.agent === name)?.name;
	return named(agent) ?? named(ownerOfReviewer(agent) ?? "");
}

export function createScreen(deps: ScreenDeps) {
	// ---------- 回复上方的标头 ----------
	let turn: { startedAt: number; triggers: Map<number, Trigger[]>; out: Set<string>; head?: number } | undefined;
	const heads = new Map<number, { label: string; index: number }>(); // 回复的时间戳 → 标头和它画在第几块上
	let headsFor: string | undefined;

	const headsFile = () => (deps.session() ? join(HEADS, `${deps.session()}.json`) : undefined);
	const loadHeads = () => {
		if (headsFor === deps.session()) return;
		headsFor = deps.session();
		heads.clear();
		const file = headsFile();
		if (!file || !existsSync(file)) return;
		try {
			for (const [ts, h] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, { label: string; index: number }>)) heads.set(Number(ts), h);
		} catch {
			// 读不了就当没有：旧回复不画标头
		}
	};
	const saveHeads = () => {
		const file = headsFile();
		if (!file) return;
		mkdirSync(HEADS, { recursive: true });
		writeAtomic(file, JSON.stringify(Object.fromEntries([...heads].slice(-HEADS_KEPT))));
	};
	const label = () => (turn ? headLabel(readTable(), deps.userTurn(), [...turn.triggers.values()].flat(), [...turn.out]) : "");

	// omp 画每一块回复文字时来问：要不要在上面加一行。只给这一轮的第一块文字加；以前画过的照原样画
	const render = ({ message, contentIndex, text }: { message: { timestamp?: number }; contentIndex: number; text: string }): string | undefined => {
		if (!deps.on() || typeof message?.timestamp !== "number") return undefined;
		loadHeads();
		let head = heads.get(message.timestamp);
		if (!head) {
			if (!turn || turn.head !== undefined || message.timestamp < turn.startedAt) return undefined;
			head = { label: label(), index: contentIndex };
			turn.head = message.timestamp;
			heads.set(message.timestamp, head);
		}
		return head.index === contentIndex ? `${headLine(head.label, cols(), width)}\n\n${text}` : undefined;
	};

	// ---------- 接收程序的故障、没人盯的盯办项 ----------
	let resumedAt = Date.now();
	let lastTick = Date.now();
	const told = new Set<string>(); // 已经随一条回复告诉过用户的故障
	let current: Fault[] = []; // 现在显示给用户、写给模型的故障
	let offered = new Set<string>(); // 最近一次写给模型时标成「新出现」的：它回了话才算告诉过
	const src = sources();

	// ---------- 久未交回 ----------
	const nextStall = new Map<string, number>(); // 任务的这一次运行 → 下一次到多少分钟提醒
	const heldSent = new Map<string, number>(); // 子代理 → 程序替它送达的最近一条交回是什么时候写的

	let shown = "";
	const widget = (ui: Ui, jobs: Job[]) => {
		const l = readTable();
		const max = cols() - 4;
		const lines: string[] = [];
		const asks = [...l.asks.values()].sort((a, b) => a.n - b.n);
		if (asks.length) {
			lines.push(`⏳ 等你定 ${asks.length} 件`);
			for (const a of asks.slice(0, ASKS_SHOWN)) lines.push(clipTo(`   ${a.n}  ${a.line} · ${a.text.replace(/\s+/g, " ")}`, max));
			if (asks.length > ASKS_SHOWN) lines.push(`   … 还有 ${asks.length - ASKS_SHOWN} 件`);
		}
		const busy = jobs.map(j => describe(l, j)).filter((s): s is string => !!s);
		if (busy.length) lines.push(clipTo(`🏃 在跑：${busy.join("；")}`, max));
		if (current.length) lines.push(clipTo(`⚠️ ${current.map(f => f.text).join("；")}`, max));
		const next = lines.join("\n");
		if (next === shown) return;
		shown = next;
		ui.setWidget?.(WIDGET_KEY, lines.length ? lines : undefined, { placement: "aboveEditor" });
	};

	const stepOf = (agent: string): Step | undefined => {
		const dir = deps.sessionDir();
		return dir ? lastStep(join(dir, `${agent}.jsonl`)) : undefined;
	};
	// 一个在跑的子代理，给人看的一句：哪个任务、跑了多久、在做什么。不是任务的负责 agent 或审查者的不说
	function describe(l: Table, j: Job): string | undefined {
		const agent = j.agentId ?? j.id;
		const task = j.type === "task" && !agent.includes(".") ? taskOfJob(l, agent) : undefined;
		if (!task) return undefined;
		const ran = j.startTime ? span(minutes(Date.now() - j.startTime)) : "";
		const step = stepOf(agent);
		const doing = step?.ended ? "已写完交回，它后台还有活在跑" : (step?.what ?? "");
		return [ownerOfReviewer(agent) && !openTasks(l).some(t => t.agent === agent) ? `${task} 的审查` : task, ran, doing].filter(Boolean).join(" · ");
	}

	return {
		render,
		// 一轮开始（用户发话或被叫醒）
		turnStart() {
			turn = { startedAt: Date.now(), triggers: new Map(), out: new Set() };
		},
		// 每次请求前：看这一轮是被什么叫醒的
		context(messages: unknown[]) {
			if (!turn) return;
			for (const t of tailTriggers(messages)) turn.triggers.set(t.at, t.triggers);
		},
		// 主会话这一轮把活交给了某个子代理
		handedTo(agent: string) {
			turn?.out.add(agent);
		},
		// 一轮结束：这一轮里后来才发生的交出也要算进标头，变了就重画
		turnEnd(ui: Ui | undefined) {
			if (turn?.head !== undefined) {
				const head = heads.get(turn.head);
				const final = label();
				if (head && head.label !== final) {
					head.label = final;
					ui?.rerenderMessage?.(turn.head);
				}
				try {
					saveHeads();
				} catch (err) {
					logError("heads", err);
				}
			}
			turn = undefined;
		},
		// 主会话给用户回了一条：现在的故障算是告诉过了
		replied() {
			for (const key of offered) told.add(key);
			offered = new Set();
		},
		// 给任务表摘要用：哪些接收程序坏了、每个任务有几项没人盯
		monitoring(): Monitoring {
			offered = new Set(current.filter(f => !told.has(f.key)).map(f => f.key));
			return { faults: current.map(f => ({ text: f.text, fresh: offered.has(f.key) })), unobserved: watch => watch.filter(w => !observed(w, src)).length };
		},
		// 登记盯办项时告诉模型：哪些有程序在读，哪些没有
		coverage(entries: string[]): string {
			const blind = entries.filter(w => !observed(w, src));
			if (!blind.length) return "";
			return ` NOT observed by any source: ${blind.map(w => `"${w}"`).join(", ")}. Nobody will be told when these change; they only help route messages that arrive through other watched places. Sources read Slack message, thread, channel and DM links${src.slack ? "" : " (Slack is not configured on this machine)"}, GitHub PR links${src.ado ? `, and Azure DevOps PR links in ${src.ado}` : ""}. For anything else, set a chase date on an item and have the owner check it.`;
		},
		// 给任务表摘要用：在跑的子代理，带已跑多久和在做什么
		running(jobs: Job[]): string[] {
			const l = readTable();
			return jobs.map(j => {
				const agent = j.agentId ?? j.id;
				const task = j.type === "task" ? taskOfJob(l, agent.split(".")[0]) : undefined;
				const ran = j.startTime ? `running ${minutes(Date.now() - j.startTime)} min` : "";
				const step = j.type === "task" ? stepOf(agent) : undefined;
				const doing = step?.ended ? "finished its turn, still has background work" : step?.what ? `last step "${step.what}" since ${minutes(Date.now() - step.since)} min ago` : "";
				return `${j.id}${[task, ran, doing].some(Boolean) ? ` (${[task, ran, doing].filter(Boolean).join(", ")})` : ""}`;
			});
		},
		// 把未完成任务登记的、读得到的盯办项写给接收程序
		writePlan() {
			try {
				const l = readTable();
				mkdirSync(join(WATCH_PLAN, ".."), { recursive: true });
				writeAtomic(WATCH_PLAN, JSON.stringify(watchPlan(openTasks(l).map(t => ({ name: t.name, watch: t.watch })), src), null, 1));
			} catch (err) {
				logError("watch plan", err);
			}
		},
		// 每 5 秒一次
		tick(ui: Ui, jobs: Job[]) {
			const now = Date.now();
			if (now - lastTick > 60_000) resumedAt = now; // 机器休眠过：刚醒来的一个周期内不判故障
			lastTick = now;
			// 刚从休眠醒来的宽限期只挡新出现的故障：已经告诉过用户的照旧显示，也不会在宽限期过后当成新的再报一遍
			const health = readHealth();
			const real = faults(health, now, Number.NEGATIVE_INFINITY);
			const settled = new Set(faults(health, now, resumedAt).map(f => f.key));
			for (const key of told) if (!real.some(f => f.key === key)) told.delete(key);
			current = real.filter(f => settled.has(f.key) || told.has(f.key));

			const l = readTable();
			const session = deps.session();
			// 被 omp 压着的交回
			if (session) {
				for (const h of dueHandbacks(join(HELD, session), now, HELD_GRACE_MS)) {
					const task = taskOfJob(l, h.agent);
					heldSent.set(h.agent, h.at);
					deps.send({
						customType: "chengxiangfu-handback",
						content: `[HELD HAND-BACK · from agent://${h.agent}${task ? ` (task ${task})` : ""} · written ${new Date(h.at).toLocaleTimeString("sv-SE").slice(0, 5)}] omp has not delivered this hand-back: the agent finished its turn but still has a background job or helper running, and omp reports an agent only when it is fully idle. Treat the text below as its hand-back now. omp may deliver the same or a later result when the agent goes idle; do not act on a duplicate twice.\n${h.text}`,
						display: true,
						attribution: "agent",
					});
				}
			}
			// 久未交回：到点叫醒主会话去看一眼，之后每次翻倍
			const every = settings().stall_minutes;
			const live = new Set<string>();
			for (const j of jobs) {
				const agent = j.agentId ?? j.id;
				const task = j.type === "task" && !agent.includes(".") && j.startTime ? taskOfJob(l, agent) : undefined;
				if (!task || !j.startTime) continue;
				const key = `${j.id}:${j.startTime}`;
				live.add(key);
				const ran = minutes(now - j.startTime);
				const due = nextStall.get(key) ?? every;
				if (every <= 0 || ran < due) continue;
				const step = stepOf(agent);
				// 它这一轮已经写完、那条交回程序也送达了：主会话手里有东西可处理，不算久未交回
				if (step?.ended && (heldSent.get(agent) ?? 0) >= step.since) continue;
				nextStall.set(key, due * 2);
				const doing = step?.ended
					? `It finished its last turn ${minutes(now - step.since)} min ago but still has a background job or helper running, which keeps omp from reporting it as done.`
					: step?.what
						? `Last step: "${step.what}", started ${minutes(now - step.since)} min ago.`
						: "";
				deps.send({
					customType: "chengxiangfu-stall",
					content: `[NO HAND-BACK · agent://${agent} (task ${task}) has been running for ${ran} min without handing back] ${doing} Look at what it is doing (read history://${agent}). If it is stuck or waiting on something slow, write agent://${agent} to make it report progress, stop the background work, or change approach. Tell the operator only if they are waiting on this task or it needs them; otherwise reply with one short line.`,
					display: true,
					attribution: "agent",
				});
			}
			for (const key of nextStall.keys()) if (!live.has(key)) nextStall.delete(key);
			for (const agent of heldSent.keys()) if (!jobs.some(j => (j.agentId ?? j.id) === agent)) heldSent.delete(agent);

			widget(ui, jobs);
		},
		// 关掉调度器模式：把固定区撤掉
		clear(ui: Ui) {
			shown = "";
			ui.setWidget?.(WIDGET_KEY, undefined);
		},
	};
}

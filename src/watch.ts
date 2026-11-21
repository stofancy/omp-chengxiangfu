// 外部消息按任务归位：把登记在任务上的「要盯的外部输入」和一条外部消息规范成可比较的键，判断消息属于哪个任务。
//
// 键的强弱：thread、消息、PR、同一个链接、工单号 = 精确（2）；只登记到会话 = 会话级（1）。
// 命中多个任务时，取最强的一档；这一档里仍然多个就都不归，由主会话研判。

interface WatchKey {
	level: 1 | 2;
	key: string;
	channel?: string; // 会话级登记用这个键匹配会话中的消息
}

export interface Message { link?: string; where?: string; note?: string }
export interface Watching { name: string; watch: string[] }
export interface Match { task?: string; candidates: string[] }

const SLACK = /^https?:\/\/[^/?#\s]+\.slack\.com\/archives\/([A-Za-z0-9]+)(?:\/p(\d{16}))?(?:[/?#]|$)/;
const FEISHU = /^https:\/\/applink\.feishu\.cn\/client\/chat\/open\?([^#\s]*)/;

function feishuLink(url: string): { chat: string; position?: string } | undefined {
	const query = FEISHU.exec(url)?.[1];
	if (!query) return;
	const params = new URLSearchParams(query);
	const chat = params.get("openChatId");
	if (!chat || !/^oc_[A-Za-z0-9]+$/.test(chat)) return;
	const position = params.get("position");
	return { chat, position: position && /^\d+$/.test(position) ? position : undefined };
}
const PR_GITHUB = /^https?:\/\/(?:www\.)?(github\.com\/[^/?#\s]+\/[^/?#\s]+\/pull\/\d+)(?:[/?#]|$)/i;
const PR_ADO = /^https?:\/\/([^?#\s]*?\/_git\/[^/?#\s]+\/pullrequest\/\d+)(?:[/?#]|$)/i;

const isLink = (s: string) => /^https?:\/\//i.test(s);

function decode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

// 链接规范成键；不是链接返回 undefined
function linkKey(raw: string): WatchKey | undefined {
	const url = raw.trim();
	if (!isLink(url)) return undefined;
	const slack = SLACK.exec(url);
	if (slack) {
		const [, channel, p] = slack;
		const threadTs = /[?&]thread_ts=(\d+\.\d+)/.exec(url)?.[1];
		const ts = threadTs ?? (p ? `${p.slice(0, 10)}.${p.slice(10)}` : undefined);
		return ts ? { level: 2, key: `slack:${channel}:${ts}`, channel: `slack:${channel}` } : { level: 1, key: `slack:${channel}`, channel: `slack:${channel}` };
	}
	const feishu = feishuLink(url);
	if (feishu) {
		const channel = `feishu:${feishu.chat}`;
		return feishu.position ? { level: 2, key: `${channel}:${feishu.position}`, channel } : { level: 1, key: channel, channel };
	}
	const pr = PR_GITHUB.exec(url) ?? PR_ADO.exec(url);
	if (pr) return { level: 2, key: `pr:${decode(pr[1]).toLowerCase()}` };
	return { level: 2, key: `url:${url.replace(/[?#].*$/, "").replace(/\/+$/, "")}` };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 不是链接的标识（工单号等）：在消息的 where / note / link 里按整词出现
const hasWord = (id: string, msg: Message) => {
	const re = new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(id)}(?![A-Za-z0-9_-])`, "i");
	return [msg.where, msg.note, msg.link].some(t => !!t && re.test(t));
};

// 一条登记（watch 里的一项）对这条消息的命中强度：0 = 不命中
function strength(watch: string, msg: Message): 0 | 1 | 2 {
	const w = watch.trim();
	if (!w) return 0;
	if (!isLink(w)) return hasWord(w, msg) ? 2 : 0;
	const wk = linkKey(w);
	const mk = msg.link ? linkKey(msg.link) : undefined;
	if (!wk || !mk) return 0;
	if (wk.key === mk.key) return wk.level;
	// 只登记到会话：匹配该会话的所有消息（包括 thread 里的）
	if (wk.level === 1 && mk.channel && wk.channel === mk.channel) return 1;
	return 0;
}

export function matchTask(msg: Message, tasks: Watching[]): Match {
	let best = 0;
	let hits: string[] = [];
	for (const t of tasks) {
		const s = Math.max(0, ...t.watch.map(w => strength(w, msg)));
		if (s > best) {
			best = s;
			hits = [t.name];
		} else if (s === best && s > 0) hits.push(t.name);
	}
	return { task: hits.length === 1 ? hits[0] : undefined, candidates: hits.length > 1 ? hits : [] };
}

// ---------- 盯办项由哪个接收程序去读 ----------
// 登记在任务上的链接不只用来归位：接收程序照这份清单定监听范围（否则只有配置里写死的频道和自己开的 PR 有消息）。

export type Target =
	| { kind: "slack"; channel: string; thread?: string } // thread 是那条消息的 ts；没有就是整个频道或私信
	| { kind: "feishu"; chat: string }
	| { kind: "github"; repo: string; number: number }
	| { kind: "ado"; org: string; project: string; repo: string; id: number }
	| { kind: "none" }; // 工单号、别的链接、随手写的说明：没有程序读得到

const GITHUB_PARTS = /^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+\/[^/?#\s]+)\/pull\/(\d+)(?:[/?#]|$)/i;
const ADO_PARTS = /^https?:\/\/dev\.azure\.com\/([^/?#\s]+)\/([^/?#\s]+)\/_git\/([^/?#\s]+)\/pullrequest\/(\d+)(?:[/?#]|$)/i;

export function targetOf(entry: string): Target {
	const url = entry.trim();
	const slack = SLACK.exec(url);
	if (slack) {
		const thread = /[?&]thread_ts=(\d+\.\d+)/.exec(url)?.[1] ?? (slack[2] ? `${slack[2].slice(0, 10)}.${slack[2].slice(10)}` : undefined);
		return { kind: "slack", channel: slack[1], thread };
	}
	const feishu = feishuLink(url);
	if (feishu) return { kind: "feishu", chat: feishu.chat };
	const gh = GITHUB_PARTS.exec(url);
	if (gh) return { kind: "github", repo: gh[1], number: Number(gh[2]) };
	const ado = ADO_PARTS.exec(url);
	if (ado) return { kind: "ado", org: decode(ado[1]), project: decode(ado[2]), repo: decode(ado[3]), id: Number(ado[4]) };
	return { kind: "none" };
}

// 本机配了哪些接收程序（config.json）：GitHub 的 PR 轮询不用配置
export interface Sources { slack: boolean; feishu: boolean; ado?: string }

// 这一项有没有接收程序在读。读不到的仍然用来把从别处进来的消息归到任务
export function observed(entry: string, s: Sources): boolean {
	return isObserved(targetOf(entry), s);
}

function isObserved(t: Target, s: Sources): boolean {
	if (t.kind === "slack") return s.slack;
	if (t.kind === "feishu") return s.feishu;
	if (t.kind === "ado") return !!s.ado && s.ado.toLowerCase() === t.org.toLowerCase();
	return t.kind === "github";
}

export interface WatchPlan {
	slack: Array<{ task: string; channel: string; thread?: string }>;
	feishu: Array<{ task: string; chat: string; whole: boolean }>;
	github: Array<{ task: string; repo: string; number: number }>;
	ado: Array<{ task: string; project: string; repo: string; id: number }>;
}

// 未完成任务登记的、读得到的盯办项，去重后交给接收程序。同一项登记在两个任务上只留一条：归哪个任务由归位规则另行判断
export function watchPlan(tasks: Watching[], s: Sources): WatchPlan {
	const plan: WatchPlan = { slack: [], feishu: [], github: [], ado: [] };
	const seen = new Set<string>();
	const chats = new Map<string, WatchPlan["feishu"][number]>();
	for (const t of tasks) {
		for (const entry of t.watch) {
			const target = targetOf(entry);
			if (!isObserved(target, s)) continue;
			if (target.kind === "feishu") {
				const whole = !feishuLink(entry.trim())?.position;
				const previous = chats.get(target.chat);
				if (!previous || (whole && !previous.whole)) chats.set(target.chat, { task: t.name, chat: target.chat, whole });
				continue;
			}
			const key = JSON.stringify(target).toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			if (target.kind === "slack") plan.slack.push({ task: t.name, channel: target.channel, thread: target.thread });
			else if (target.kind === "github") plan.github.push({ task: t.name, repo: target.repo, number: target.number });
			else if (target.kind === "ado") plan.ado.push({ task: t.name, project: target.project, repo: target.repo, id: target.id });
		}
	}
	plan.feishu = [...chats.values()];
	return plan;
}

// 外部消息按任务归位：把登记在任务上的「要盯的外部输入」和一条外部消息规范成可比较的键，判断消息属于哪个任务。
//
// 键的强弱：thread、PR、同一个链接、工单号 = 精确（2）；只登记到频道 = 频道级（1）。
// 命中多个任务时，取最强的一档；这一档里仍然多个就都不归，由主会话研判。

interface WatchKey {
	level: 1 | 2;
	key: string;
	channel?: string; // Slack：这个键所在的频道，频道级的登记用它匹配 thread 消息
}

export interface Message { link?: string; where?: string; note?: string }
export interface Watching { name: string; watch: string[] }
export interface Match { task?: string; candidates: string[] }

const SLACK = /^https?:\/\/[^/?#\s]+\.slack\.com\/archives\/([A-Za-z0-9]+)(?:\/p(\d{16}))?(?:[/?#]|$)/;
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
		return ts ? { level: 2, key: `slack:${channel}:${ts}`, channel } : { level: 1, key: `slack:${channel}`, channel };
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
	// 只登记到频道：匹配该频道的所有消息（包括 thread 里的）
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

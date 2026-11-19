// 接收程序（Slack 推送、定时补读、PR 轮询、提醒）是否还在正常工作。
// 每个程序每次成功都在 state/health/ 下记一笔；这里只读，判断谁超时没成功。
// 没有消息进来时，「没有动静」和「接收程序坏了」在任务表里看不出区别，所以要单独看这个。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HEALTH } from "./paths";

export interface Health {
	label: string; // 给人看的名字，如「Slack 推送」
	every_s: number; // 正常情况下多久成功一次
	ok_at?: string; // 最后一次成功
	error?: string; // 最近一次失败的原因；成功后清掉
	error_at?: string;
	error_since?: string; // 连续出错是从什么时候开始的
}
export interface Fault { key: string; text: string }

export function readHealth(dir: string = HEALTH): Map<string, Health> {
	const out = new Map<string, Health>();
	if (!existsSync(dir)) return out;
	for (const f of readdirSync(dir).filter(n => n.endsWith(".json")).sort()) {
		try {
			const h = JSON.parse(readFileSync(join(dir, f), "utf8")) as Health;
			if (h && typeof h.label === "string" && typeof h.every_s === "number") out.set(f.slice(0, -5), h);
		} catch {
			// 正在写的半个文件：下一拍再读
		}
	}
	return out;
}

const ago = (ms: number) => {
	const min = Math.round(ms / 60_000);
	return min < 90 ? `${min} 分钟` : min < 48 * 60 ? `${Math.round(min / 60)} 小时` : `${Math.round(min / 1440)} 天`;
};
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

// 超过三个周期（至少 3 分钟）没成功的算故障；每次都跑完但一直有一部分读不到的（同一个错持续了三个周期）也算。
// 偶尔一次失败不算。resumedAt：本进程启动或从休眠恢复的时刻，之后一个周期内不判：机器休眠时谁都没跑，刚醒来那一会儿不是故障
export function faults(all: Map<string, Health>, now: number, resumedAt: number): Fault[] {
	const out: Fault[] = [];
	for (const [key, h] of all) {
		if (now < resumedAt + (h.every_s + 60) * 1000) continue;
		const limit = Math.max(h.every_s * 3, 180) * 1000;
		const last = h.ok_at ? Date.parse(h.ok_at) : Number.NaN;
		const error = h.error ? clip(h.error.replace(/\s+/g, " "), 80) : "";
		const why = error ? `（最近的错：${error}）` : "";
		if (Number.isNaN(last)) out.push({ key, text: `${h.label}从没成功过${why}` });
		else if (now - last > limit) out.push({ key, text: `${h.label}已 ${ago(now - last)}没正常工作${why}` });
		else if (error && h.error_since && now - Date.parse(h.error_since) > limit) out.push({ key, text: `${h.label}有一部分一直读不到（${error}）` });
	}
	return out;
}

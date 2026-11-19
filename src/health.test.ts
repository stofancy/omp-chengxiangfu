import { expect, test } from "bun:test";
import { type Health, faults } from "./health";

const NOW = Date.parse("2026-11-19T04:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const LONG_AGO = NOW - 86_400_000; // 进程启动很久了：不在刚恢复的宽限期里
const check = (h: Health, resumedAt = LONG_AGO) => faults(new Map([["x", h]]), NOW, resumedAt).map(f => f.text);

test("超过三个周期没成功的算故障，写明多久了和最近的错；周期内的不算", () => {
	expect(check({ label: "Slack 实时推送", every_s: 60, ok_at: ago(2) })).toEqual([]);
	expect(check({ label: "Slack 实时推送", every_s: 60, ok_at: ago(15 * 60) })).toEqual(["Slack 实时推送已 15 小时没正常工作"]);
	expect(check({ label: "提醒", every_s: 1800, ok_at: ago(80) })).toEqual([]); // 30 分钟一次的，80 分钟还在三个周期内
	expect(check({ label: "提醒", every_s: 1800, ok_at: ago(150), error: "'text'", error_at: ago(20) })).toEqual(["提醒已 3 小时没正常工作（最近的错：'text'）"]);
	expect(check({ label: "PR 轮询", every_s: 300, error: "gh: not logged in", error_at: ago(1) })).toEqual(["PR 轮询从没成功过（最近的错：gh: not logged in）"]);
});

test("每次都跑完但一直有一部分读不到的也算；偶尔一次失败不算", () => {
	const partial = { label: "Slack 定时补读", every_s: 600, ok_at: ago(1), error: "thread in #x: channel_not_found", error_at: ago(1) };
	expect(check({ ...partial, error_since: ago(5) })).toEqual([]);
	expect(check({ ...partial, error_since: ago(45) })).toEqual(["Slack 定时补读有一部分一直读不到（thread in #x: channel_not_found）"]);
});

test("机器休眠刚醒来（或进程刚启动）的一个周期内不判：这时候谁都还没来得及跑", () => {
	const stale: Health = { label: "Slack 定时补读", every_s: 600, ok_at: ago(8 * 60) };
	expect(check(stale, NOW - 5 * 60_000)).toEqual([]);
	expect(check(stale, NOW - 12 * 60_000)).toEqual(["Slack 定时补读已 8 小时没正常工作"]);
});

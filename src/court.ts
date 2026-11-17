// 朝堂：谁是丞相府。全局只有一个，记在 boss.json（会话、进程、心跳）；靠心跳和进程是否还在判断是否当值。
import { readFileSync, rmSync } from "node:fs";
import { writeAtomic } from "./ledger";
import { BOSS } from "./paths";

export const STALE_MS = 30_000; // 心跳超过这么久没更新，就当丞相府那个进程已经不在了

export interface BossState { key: string; pid: number; name: string; since: string; beat: number }

export function readBoss(): BossState | undefined {
	try {
		return JSON.parse(readFileSync(BOSS, "utf8"));
	} catch {
		return undefined;
	}
}

export const writeBoss = (s: BossState) => writeAtomic(BOSS, JSON.stringify(s, null, 2));
export const clearBoss = () => rmSync(BOSS, { force: true });

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return typeof err === "object" && err !== null && "code" in err && err.code === "EPERM"; // 进程在但不归我们管，也算活着
	}
}

export const alive = (s: BossState) => Date.now() - s.beat < STALE_MS && pidAlive(s.pid);

// 本进程里的这个会话是不是丞相府（同一会话被两个进程打开时，只认持有者）
export const heldBy = (s: BossState | undefined, key: string | undefined): boolean => !!s && !!key && s.key === key && s.pid === process.pid;

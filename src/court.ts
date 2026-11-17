// 账本归属：每个 omp 会话默认用自己的账本（账本 id = 会话 id）；/bind 之后改用别的账本。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLines, readLedger, writeAtomic } from "./ledger";
import { BINDINGS, COURTS } from "./paths";

export interface CourtInfo { id: string; name: string; ledger: Ledger }

export function courtOf(session: string): string {
	try {
		return readFileSync(join(BINDINGS, session), "utf8").trim() || session;
	} catch {
		return session;
	}
}

export const bind = (session: string, court: string) => writeAtomic(join(BINDINGS, session), court);

// 账本名记在 courts/<账本>/name，跟着创建它的会话的标题更新
export const setCourtName = (court: string, name: string) => writeAtomic(join(COURTS, court, "name"), name);

export function courts(): CourtInfo[] {
	if (!existsSync(COURTS)) return [];
	return readdirSync(COURTS).map(id => {
		let name = id;
		try {
			name = readFileSync(join(COURTS, id, "name"), "utf8").trim() || id;
		} catch {}
		return { id, name, ledger: readLedger(id) };
	});
}

// 外部消息送给谁：有线、且有账本在管这条线的，送给那个账本；否则送给你最近发过话的账本。
// 候选不止一个时，取你最近发过话的那个。
export function route(line: string | undefined, all: CourtInfo[]): string | undefined {
	const owners = line ? all.filter(c => openLines(c.ledger).has(line)) : [];
	const pool = owners.length ? owners : all;
	return [...pool].sort((a, b) => (b.ledger.lastInput ?? "").localeCompare(a.ledger.lastInput ?? ""))[0]?.id;
}

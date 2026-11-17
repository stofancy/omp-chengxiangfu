// 朝廷：每个 omp 会话默认自己开一个朝廷（朝廷名 = 会话 id）；/bind 之后改用别的朝廷的军簿。
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

// 朝廷名记在 courts/<朝廷>/name，主公每次发话时按当前会话名更新
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

// 军报送给谁：有线、且有朝廷在管这条线的，送给管它的朝廷；否则送给主公最近发过话的朝廷。
// 候选不止一个时，取主公最近发过话的那个。
export function route(line: string | undefined, all: CourtInfo[]): string | undefined {
	const owners = line ? all.filter(c => openLines(c.ledger).has(line)) : [];
	const pool = owners.length ? owners : all;
	return [...pool].sort((a, b) => (b.ledger.lastInput ?? "").localeCompare(a.ledger.lastInput ?? ""))[0]?.id;
}

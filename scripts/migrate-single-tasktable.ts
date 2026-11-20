// 迁移：把旧的按会话分账本（courts/*/events.jsonl）合并成全局唯一的任务表（tasks/events.jsonl），
// 旧的 courts/ 和 bindings/ 整体移到 archive/<时间戳>/。零依赖，bun 直接跑：
//   bun scripts/migrate-single-tasktable.ts            # 数据目录取 DISPATCH_DESK_HOME，默认 ~/.local/share/dispatch-desk
//   bun scripts/migrate-single-tasktable.ts <数据目录>
// 可重复运行：旧目录已经不在时什么都不做。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MigrateResult {
	migrated: boolean;
	reason?: string; // 没迁移时的原因
	lines?: number; // 写入 tasks/events.jsonl 的行数（含原来就在里面的）
	duplicates?: number; // 去掉的完全相同的重复行
	skipped?: number; // 不是合法 JSON 行的条数（原文留在 archive 里）
	archive?: string;
}

const defaultHome = () => process.env.DISPATCH_DESK_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "dispatch-desk");

// 压缩的本地时间戳，如 20261118-153045；archive 下重名时加序号
function archiveDir(home: string, now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	let dir = join(home, "archive", stamp);
	for (let i = 2; existsSync(dir); i++) dir = join(home, "archive", `${stamp}-${i}`);
	return dir;
}

export function migrate(home: string = defaultHome(), now: Date = new Date()): MigrateResult {
	const courts = join(home, "courts");
	const bindings = join(home, "bindings");
	if (!existsSync(courts) && !existsSync(bindings)) {
		return { migrated: false, reason: "没有 courts/ 和 bindings/：已经迁移过，或者本来就没有旧数据" };
	}

	const target = join(home, "tasks", "events.jsonl");
	const sources: string[] = [];
	// 已有的任务表也并进来：迁移到一半被打断、或新版本已经写过事件，都不会丢
	if (existsSync(target)) sources.push(target);
	if (existsSync(courts)) {
		for (const name of readdirSync(courts).sort()) {
			const f = join(courts, name, "events.jsonl");
			if (existsSync(f)) sources.push(f);
		}
	}

	const seen = new Set<string>();
	const rows: Array<{ ts: number; order: number; raw: string }> = [];
	let duplicates = 0;
	let skipped = 0;
	for (const f of sources) {
		for (const raw of readFileSync(f, "utf8").split("\n")) {
			if (!raw.trim()) continue;
			let ts: number;
			try {
				ts = Date.parse(String((JSON.parse(raw) as { ts?: unknown }).ts));
			} catch {
				skipped++;
				continue;
			}
			if (Number.isNaN(ts)) {
				skipped++;
				continue;
			}
			if (seen.has(raw)) {
				duplicates++;
				continue;
			}
			seen.add(raw);
			rows.push({ ts, order: rows.length, raw });
		}
	}
	rows.sort((a, b) => a.ts - b.ts || a.order - b.order); // 同一毫秒的保持读入顺序

	mkdirSync(join(home, "tasks"), { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, rows.map(r => `${r.raw}\n`).join(""));
	renameSync(tmp, target);

	// 先写任务表再挪旧目录：中途失败时旧目录还在，重跑会再合并一次（重复行会被去掉）
	const archive = archiveDir(home, now);
	mkdirSync(archive, { recursive: true });
	for (const dir of [courts, bindings]) if (existsSync(dir)) renameSync(dir, join(archive, dir === courts ? "courts" : "bindings"));
	return { migrated: true, lines: rows.length, duplicates, skipped, archive };
}

if (import.meta.main) {
	const home = process.argv[2] ?? defaultHome();
	const r = migrate(home);
	if (!r.migrated) console.log(`无需迁移：${r.reason}（数据目录 ${home}）`);
	else console.log(`已迁移：${r.lines} 行写入 ${join(home, "tasks/events.jsonl")}，去掉重复 ${r.duplicates} 行，跳过非 JSON ${r.skipped} 行；旧目录已移到 ${r.archive}`);
}

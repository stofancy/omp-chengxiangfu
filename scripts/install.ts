import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { HOME, PLUGIN_ROOT } from "../src/paths";
import { hasFeishu, readConfig, runSetup, type SetupUI } from "../src/setup";
import { writeAtomic } from "../src/table";

const DRY = process.argv.includes("--dry-run");
const ROOT = realpathSync(PLUGIN_ROOT);
const DATA = resolve(HOME);
const CRON_START = "# BEGIN omp-dispatch-desk";
const CRON_END = "# END omp-dispatch-desk";
const UNIT_MARKER = "# 由 omp-dispatch-desk 安装程序管理\n";

function run(command: string, args: string[] = [], input?: string) {
	return spawnSync(command, args, {
		encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
		...(input === undefined ? {} : { input }),
	});
}

function checked(command: string, args: string[] = [], input?: string): string {
	const result = run(command, args, input);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || `${[command, ...args].join(" ")} 失败（${result.status}）`);
	return result.stdout;
}

async function install(rl?: Interface) {
	const packages = ["omp", "bun", "python3", "gh", "lark-cli"] as const;
	const binaries = Object.fromEntries(packages.map(command => [command, Bun.which(command)]));
	console.log("检查命令：");
	for (const command of packages) console.log(`  ${command}: ${binaries[command] ?? "未找到"}`);
	const { omp, bun, python3, gh, "lark-cli": lark } = binaries;
	if (!omp || !bun || !python3 || !gh) throw new Error("请先安装 omp、bun、python3、gh。");
	const stamp = new Date().toISOString().replace(/:/g, "-");
	const ask = async (title: string, message: string) => {
		console.log(`${title}：${message}`);
		return rl ? /^(y|yes)$/i.test((await rl.question("确认？[y/N] ")).trim()) : false;
	};

	const { name } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const plugins = JSON.parse(checked(omp, ["plugin", "list", "--json"])) as { npm: Array<{ name: string; path: string }> };
	const linked = plugins.npm.some(p => p.name === name && existsSync(p.path) && realpathSync(p.path) === ROOT);
	if (linked) console.log(`omp 插件已链接，跳过：${ROOT}`);
	else if (await ask("链接 omp 插件", `omp plugin link ${ROOT}`)) checked(omp, ["plugin", "link", ROOT]);

	if (existsSync(DATA)) console.log(`数据目录已存在：${DATA}`);
	else if (await ask("创建数据目录", DATA)) mkdirSync(DATA, { recursive: true });
	else if (!DRY) return;

	if (DRY) console.log("跳过交互配置；按当前 config.json 预览部署。");
	else if (rl && await ask("配置调度台", "启动配置向导；保存前另行确认。")) {
		const terminal: SetupUI = {
			async select(title, options) {
				console.log(title);
				for (const [i, option] of options.entries()) console.log(`  ${i + 1}. ${option}`);
				for (;;) {
					const answer = (await rl.question("选择编号（回车取消）：")).trim();
					if (!answer) return;
					const index = Number(answer) - 1;
					if (Number.isInteger(index) && options[index] !== undefined) return options[index];
				}
			},
			input: title => rl.question(`${title}：`),
			async editor(title, prefill) {
				console.log(title);
				const dir = mkdtempSync(join(tmpdir(), "dispatch-desk-editor-"));
				try {
					const file = join(dir, "about.txt");
					writeFileSync(file, prefill ?? "");
					rl.pause();
					const editor = process.env.VISUAL || process.env.EDITOR || "vi";
					const result = spawnSync("sh", ["-c", `${editor} "$1"`, "editor", file], { stdio: "inherit" });
					if (result.error) throw result.error;
					if (result.status === 0) return readFileSync(file, "utf8");
				} finally {
					rl.resume();
					rmSync(dir, { recursive: true, force: true });
				}
			},
			confirm: ask,
			notify: message => console.log(message),
		};
		await runSetup(terminal);
	}

	const config = readConfig();
	const feishu = hasFeishu(config);
	if (feishu && !lark && !DRY) throw new Error("飞书已配置，请先安装 lark-cli 再部署。");
	const cronPaths = [dirname(omp), dirname(gh), dirname(python3), ...(lark ? [dirname(lark)] : []), "/usr/local/bin", "/usr/bin", "/bin"];
	const path = [...new Set(cronPaths)].join(":");
	const pollers = ["pr", ...(config.reminders ? ["reminders"] : []), ...(config.slack ? ["slack"] : []), ...(feishu ? ["feishu"] : [])];
	const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
	// cron 不保留输出：每个轮询追加到数据目录 logs/ 下自己的日志，出错时有处可查
	const logs = join(DATA, "logs");
	const jobs = pollers.map(p => `*/5 * * * * cd ${shellQuote(join(ROOT, "sources"))} && PATH=${shellQuote(path)} DISPATCH_DESK_HOME=${shellQuote(DATA)} flock -n /tmp/dispatch-desk-${p}.lock python3 ${p}_poll.py >> ${shellQuote(join(logs, `${p}_poll.log`))} 2>&1`.replace(/%/g, "\\%"));
	const block = [CRON_START, ...jobs, CRON_END].join("\n");
	const crontab = run("crontab", ["-l"]);
	if (crontab.error) throw crontab.error;
	if (crontab.status !== 0 && !crontab.stderr.includes("no crontab for")) throw new Error(crontab.stderr.trim());
	const oldCron = crontab.status === 0 ? crontab.stdout : "";
	const currentBlock = /^# BEGIN omp-dispatch-desk\n[\s\S]*?^# END omp-dispatch-desk$/m;
	const newCron = currentBlock.test(oldCron) ? oldCron.replace(currentBlock, () => block) : `${oldCron}${oldCron && !oldCron.endsWith("\n") ? "\n" : ""}${block}\n`;
	const backup = join(DATA, `crontab.bak.${stamp}`);
	if (oldCron === newCron) console.log(`crontab 块已是最新：\n${block}`);
	else if (await ask("更新 crontab", `备份当前内容到 ${backup}，仅写入下列管理块：\n${block}`)) {
		writeFileSync(backup, oldCron, { mode: 0o600, flag: "wx" });
		mkdirSync(logs, { recursive: true });
		checked("crontab", ["-"], newCron);
	}

	const units = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
	const enabled = { slack: !!config.slack, feishu: !!config.feishu?.accounts?.some(a => a.realtime) };
	for (const [source, active] of Object.entries(enabled)) {
		const name = `dispatch-desk-${source}.service`;
		const file = join(units, name);
		const oldUnit = existsSync(file) ? readFileSync(file, "utf8") : undefined;
		const backup = join(DATA, `${name}.bak.${stamp}`);
		if (!active) {
			if (oldUnit?.startsWith(UNIT_MARKER) && await ask("移除 systemd 用户服务", `备份 ${file} 到 ${backup}，停用并删除服务。`)) {
				writeFileSync(backup, oldUnit, { mode: 0o600, flag: "wx" });
				checked("systemctl", ["--user", "disable", "--now", name]);
				rmSync(file);
				checked("systemctl", ["--user", "daemon-reload"]);
			}
			continue;
		}
		const unitQuote = (value: string) => JSON.stringify(value.replace(/%/g, "%%"));
		const unit = UNIT_MARKER + readFileSync(join(ROOT, "deploy", name), "utf8")
			.replace(/^(?:#[^\n]*\n)+/, "")
			.replace(/^\[Service\]$/m, () => `[Service]\nEnvironment=${unitQuote(`DISPATCH_DESK_HOME=${DATA}`)}`)
			.replace(/^Environment=PATH=<lark-cli-bin-dir>.*$/m, () => `Environment=${unitQuote(`PATH=${path}`)}`)
			.replace(/^ExecStart=<bun> <repo>\/(\S+)/m, (_full: string, script: string) => `ExecStart=${unitQuote(bun)} ${unitQuote(join(ROOT, script))}`);
		const backupInfo = oldUnit !== undefined && oldUnit !== unit ? `先备份旧文件到 ${backup}。` : "";
		if (await ask("部署 systemd 用户服务", `${file}。${backupInfo}启用并重启 ${name}：\n${unit.trimEnd()}`)) {
			if (oldUnit !== unit) {
				if (oldUnit !== undefined) writeFileSync(backup, oldUnit, { mode: 0o600, flag: "wx" });
				mkdirSync(units, { recursive: true });
				writeAtomic(file, unit);
				checked("systemctl", ["--user", "daemon-reload"]);
			}
			checked("systemctl", ["--user", "enable", name]);
			checked("systemctl", ["--user", "restart", name]);
		}
	}
	if (DRY) console.log("预览结束，未改动插件、配置、crontab 或 systemd。");
}

const rl = DRY ? undefined : createInterface({ input: process.stdin, output: process.stdout });
try {
	await install(rl);
} catch (err) {
	console.error(`安装未完成：${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
} finally {
	rl?.close();
}

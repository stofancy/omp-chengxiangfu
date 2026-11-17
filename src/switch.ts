// 调度器模式的开关：默认关；每个打开的主会话在状态目录下有一个以会话 id 命名的文件。
// 按会话 id 存，所以 omp -r / omp -c 续同一个会话时仍然是开的。
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH_STATE } from "./paths";

export const OFF_MESSAGE = "dispatcher mode is off in this session; turn it on with /调度";

const file = (sid: string, dir: string) => join(dir, sid.replace(/[\\/]/g, "_"));

export const isOn = (sid: string | undefined, dir: string = DISPATCH_STATE): boolean => !!sid && existsSync(file(sid, dir));

export function setOn(sid: string, on: boolean, dir: string = DISPATCH_STATE): void {
	if (on) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file(sid, dir), `${new Date().toISOString()}\n`);
	} else rmSync(file(sid, dir), { force: true });
}

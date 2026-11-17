"""定时检查（建议每 30 分钟）：提醒文件里到期、未完成的条目，每天写一次紧急的外部消息。

提醒文件是 JSON 数组，每项 {"id", "text", "due": "YYYY-MM-DD", "done": bool, "until"?: ISO 时间}；
路径和归属的线在 config.json 的 reminders.file / reminders.line。
"""
import json
import sys
import time
from datetime import date, datetime
from pathlib import Path

from inbox import CONFIG, load_state, save_state, write_event

SPEC = CONFIG["reminders"]
FILE = Path(SPEC["file"]).expanduser()


def main():
    sent = load_state("reminders.json", {})
    today = date.today().isoformat()
    now = datetime.now().astimezone()
    for r in json.loads(FILE.read_text()):
        rid = str(r["id"])  # 状态文件是 JSON，键总是字符串
        if r.get("done") or r.get("due", "9999") > today or sent.get(rid) == today:
            continue
        if r.get("until") and datetime.fromisoformat(r["until"]).astimezone() <= now:  # 不带时区的按本地时间
            continue
        write_event("reminder", FILE.name, rid, str(FILE), line=SPEC.get("line", "日常"), note=f"due {r['due']}: {r['text'][:200]}", urgent=True)
        sent[rid] = today
    save_state("reminders.json", sent)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{time.strftime('%F %T')} reminders poll failed: {exc}", file=sys.stderr)
        sys.exit(1)

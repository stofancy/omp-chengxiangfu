"""定时检查（建议每 30 分钟）：提醒文件里到期、未完成的条目，每天写一次紧急的外部消息。

提醒文件是 JSON 数组，每项 {"id", "text", "due", "done": bool, "until"?: ISO 时间}；
due 是 "YYYY-MM-DD"（当天第一次检查就提醒）或带时刻的 "YYYY-MM-DD HH:MM"（本机时间，到点后的第一次检查提醒）。
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


def not_due(due, now):
    """还没到提醒的时候。带时刻的按时刻比，只有日期的（或时刻写得不合法的）按日期比。"""
    if len(due) > 10:
        try:
            return datetime.fromisoformat(due.replace(" ", "T")).astimezone() > now  # 不带时区的按本地时间
        except ValueError:
            pass
    return due[:10] > now.date().isoformat()


def main():
    sent = load_state("reminders.json", {})
    today = date.today().isoformat()
    now = datetime.now().astimezone()
    for r in json.loads(FILE.read_text()):
        try:
            rid = str(r["id"])  # 状态文件是 JSON，键总是字符串
            if r.get("done") or not_due(str(r["due"]), now) or sent.get(rid) == today:
                continue
            if r.get("until") and datetime.fromisoformat(r["until"]).astimezone() <= now:  # 不带时区的按本地时间
                continue
            note = f"due {r['due']}: {r['text'][:200]}"
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            # 一条写错了（缺字段、类型不对）只跳过这一条：别的提醒照常发
            print(f"{time.strftime('%F %T')} reminders: skipped a malformed entry ({r.get('id', '?') if isinstance(r, dict) else '?'}): {exc!r}", file=sys.stderr)
            continue
        write_event("reminder", FILE.name, rid, str(FILE), line=SPEC.get("line", "日常"), note=note, urgent=True)
        sent[rid] = today
    save_state("reminders.json", sent)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{time.strftime('%F %T')} reminders poll failed: {exc}", file=sys.stderr)
        sys.exit(1)

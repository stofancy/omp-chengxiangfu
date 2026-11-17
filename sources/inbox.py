"""外部消息源共用：数据目录、配置、写外部消息、读写游标。只写本机文件。和 config.ts 保持同一套文件名规则。"""
import hashlib
import json
import os
import re
import time
from pathlib import Path

HOME = Path(os.environ.get("CHENGXIANGFU_HOME") or Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "chengxiangfu")
INBOX_NEW = HOME / "inbox" / "new"
STATE = HOME / "state"
CONFIG = json.loads((HOME / "config.json").read_text())
LINE_PATTERN = re.compile(CONFIG.get("line_pattern", r"^\s*([A-Z][A-Z0-9]+-\d+)\b"))


def line_of(title):
    """按标题开头的卡号（例如 "PROJ-123:"）归到一路。"""
    m = LINE_PATTERN.match(title or "")
    return m.group(1) if m else None


def read_secret(spec):
    raw = Path(spec["file"]).expanduser().read_text()
    return (json.loads(raw)[spec["json_key"]] if spec.get("json_key") else raw).strip()


def write_event(source, who, where, link, *, line=None, note=None, urgent=False, key=None, order_ns=None):
    """外部消息只放「谁、在哪、链接」，不放原文：原文是不可信内容，由调度会话按需只读核实。

    给了 key 时文件名由 key 决定：同一条消息（例如实时推送和轮询补读）只进一次，返回 False 表示已有。
    """
    ev = {k: v for k, v in dict(source=source, who=who, where=where, link=link, line=line, note=note, urgent=urgent).items() if v not in (None, "", False)}
    body = json.dumps(ev, ensure_ascii=False)
    suffix = f"{source}-{key}" if key else f"{source}-{hashlib.sha1(body.encode()).hexdigest()[:8]}"
    if key and any(any(d.glob(f"*-{suffix}.json")) for d in (INBOX_NEW, INBOX_NEW.parent / "claimed") if d.exists()):
        return False
    name = f"{order_ns or time.time_ns():019d}-{suffix}.json"
    INBOX_NEW.mkdir(parents=True, exist_ok=True)
    tmp = INBOX_NEW.parent / f".{name}.tmp"
    tmp.write_text(body)
    os.replace(tmp, INBOX_NEW / name)  # 先写临时文件再改名，插件不会读到半个文件
    return True


def load_state(name, default):
    try:
        return json.loads((STATE / name).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_state(name, value):
    STATE.mkdir(parents=True, exist_ok=True)
    tmp = STATE / f".{name}.tmp"
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1))
    os.replace(tmp, STATE / name)

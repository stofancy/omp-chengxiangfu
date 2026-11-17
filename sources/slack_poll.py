"""定时补读（建议每 10 分钟）：给 slack_socket.ts 兜底，补读 config.json 里 slack.channels 的频道（顶层消息和 thread 回复），
把推送断线期间漏掉的、别人发的新消息写成军报。只读 Slack。

第一次运行只记下当前位置，不回放历史。私信和 @ 到你的消息标为紧急。同一条消息推送已经写过的不会重复。
"""
import json
import sys
import time
import urllib.parse
import urllib.request

from inbox import CONFIG, load_state, read_secret, save_state, write_event

SLACK = CONFIG["slack"]
ME = SLACK["me"]
TOKEN = read_secret(SLACK["user_token"])


def api(method, **params):
    req = urllib.request.Request(f"https://slack.com/api/{method}?{urllib.parse.urlencode(params)}", headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = json.load(res)
    if not data.get("ok"):
        raise RuntimeError(f"{method}: {data.get('error')}")
    return data


def display_name(uid, users):
    if uid not in users:
        try:
            p = api("users.info", user=uid)["user"]
            users[uid] = p.get("real_name") or p.get("name") or uid
        except Exception:
            return uid
    return users[uid]


def main():
    cursors = load_state("slack-cursor.json", {})
    users = load_state("slack-users.json", {})
    now = f"{time.time():.6f}"
    found = []
    for ch, meta in SLACK["channels"].items():
        if ch not in cursors:
            cursors[ch] = now  # 第一次只记位置
            continue
        cur = float(cursors[ch])
        newest = cur
        for m in api("conversations.history", channel=ch, limit=200).get("messages", []):
            ts = float(m["ts"])
            newest = max(newest, ts)
            if ts > cur and m.get("user") != ME and m.get("subtype") in (None, "thread_broadcast"):
                found.append((ch, meta, m, None))
            if float(m.get("latest_reply", 0)) > cur:
                for r in api("conversations.replies", channel=ch, ts=m["ts"], oldest=cursors[ch], limit=200).get("messages", []):
                    rts = float(r["ts"])
                    newest = max(newest, rts)
                    if r["ts"] != m["ts"] and rts > cur and r.get("user") != ME:
                        found.append((ch, meta, r, m["ts"]))
        cursors[ch] = f"{newest:.6f}"
    written = 0
    for ch, meta, m, parent in sorted(found, key=lambda h: float(h[2]["ts"])):
        link = f"https://{SLACK['domain']}.slack.com/archives/{ch}/p{m['ts'].replace('.', '')}" + (f"?thread_ts={parent}" if parent else "")
        urgent = ch.startswith("D") or f"<@{ME}>" in m.get("text", "")
        where = meta["name"] + (" (thread reply)" if parent else "")
        written += write_event("slack", display_name(m.get("user", "?"), users), where, link, line=meta.get("line"), urgent=urgent,
                               key=f"{ch}-{m['ts']}", order_ns=int(float(m["ts"]) * 1e9))
    # 游标在军报写完之后才保存：中途失败下次会重读，宁可重复不丢
    save_state("slack-users.json", users)
    save_state("slack-cursor.json", cursors)
    if written:
        print(f"{time.strftime('%F %T')} backfilled {written} missed by the socket")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{time.strftime('%F %T')} slack poll failed: {exc}", file=sys.stderr)
        sys.exit(1)

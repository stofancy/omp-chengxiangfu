"""定时补读（建议每 10 分钟）：给 slack_socket.ts 兜底，把推送断线期间漏掉的、别人发的新消息写成外部消息。只读 Slack。

读哪些地方：config.json 里 slack.channels 的频道，加上未完成任务登记要盯的频道、私信和 thread（插件写在 state/watch.json）。
一个地方第一次读只记下当前位置，不回放历史。私信和 @ 到你的消息标为紧急。同一条消息推送已经写过的不会重复。
"""
import json
import sys
import time
import urllib.parse
import urllib.request

from inbox import CONFIG, health, load_state, read_secret, save_state, watch_plan, write_event

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


def place_name(ch, users):
    """频道或私信给人看的名字，和用户名共用一个缓存；查不到就用 ID。"""
    if ch not in users:
        try:
            c = api("conversations.info", channel=ch)["channel"]
            users[ch] = f"DM {display_name(c['user'], users)}" if c.get("is_im") else "group DM" if c.get("is_mpim") else f"#{c.get('name', ch)}"
        except Exception:
            return ch
    return users[ch]


THREAD_WINDOW = 7 * 86400  # 整个频道在读时，只看最近 7 天发起的 thread 里的新回复；更早的 thread 要单独登记


def history(ch, oldest):
    """翻页读完 oldest 之后的全部顶层消息：只读第一页会在消息多时永久漏掉。"""
    cursor = None
    while True:
        page = api("conversations.history", channel=ch, oldest=oldest, limit=200, **({"cursor": cursor} if cursor else {}))
        yield from page.get("messages", [])
        cursor = page.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            return


def main():
    cursors = load_state("slack-cursor.json", {})
    users = load_state("slack-users.json", {})
    now = f"{time.time():.6f}"
    found = []
    failed = []
    plan = watch_plan().get("slack", [])
    channels = dict(SLACK["channels"])
    for w in plan:  # 任务登记的整个频道或私信：和配置里的频道一样读
        if not w.get("thread") and w["channel"] not in channels:
            channels[w["channel"]] = {"name": place_name(w["channel"], users), "line": w["task"]}
    for ch, meta in channels.items():
        if ch not in cursors:
            cursors[ch] = now  # 第一次只记位置
            continue
        cur = float(cursors[ch])
        newest = cur
        try:
            for m in history(ch, f"{cur - THREAD_WINDOW:.6f}"):
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
        except Exception as exc:  # 一个地方读不了不影响别的；它的游标不动，下次重读
            failed.append(f"{meta['name']}: {exc}")
            continue
        cursors[ch] = f"{newest:.6f}"
    for w in plan:  # 任务登记的单条 thread。所在频道已经整个在读也照读：早于 7 天的 thread 上面读不到，重复的写不进去
        if not w.get("thread"):
            continue
        ch, parent, key = w["channel"], w["thread"], f"{w['channel']}:{w['thread']}"
        if key not in cursors:
            cursors[key] = now
            continue
        cur = float(cursors[key])
        newest = cur
        meta = {"name": place_name(ch, users), "line": w["task"]}
        try:
            for r in api("conversations.replies", channel=ch, ts=parent, oldest=cursors[key], limit=200).get("messages", []):
                rts = float(r["ts"])
                newest = max(newest, rts)
                if r["ts"] != parent and rts > cur and r.get("user") != ME:
                    found.append((ch, meta, r, parent))
        except Exception as exc:
            failed.append(f"thread in {meta['name']}: {exc}")
            continue
        cursors[key] = f"{newest:.6f}"
    written = 0
    for ch, meta, m, parent in sorted(found, key=lambda h: float(h[2]["ts"])):
        link = f"https://{SLACK['domain']}.slack.com/archives/{ch}/p{m['ts'].replace('.', '')}" + (f"?thread_ts={parent}" if parent else "")
        urgent = ch.startswith("D") or f"<@{ME}>" in m.get("text", "")
        where = meta["name"] + (" (thread reply)" if parent else "")
        written += write_event("slack", display_name(m.get("user", "?"), users), where, link, line=None if urgent else meta.get("line"), urgent=urgent,
                               key=f"{ch}-{m['ts']}", order_ns=int(float(m["ts"]) * 1e9))
    # 不再登记的地方把游标丢掉：以后重新登记时从那一刻读起，不回放中间这段。配置里的频道一直留着
    live = set(channels) | {f"{w['channel']}:{w['thread']}" for w in plan if w.get("thread")}
    cursors = {k: v for k, v in cursors.items() if k in live}
    # 游标在消息写完之后才保存：中途失败下次会重读，宁可重复不丢
    save_state("slack-users.json", users)
    save_state("slack-cursor.json", cursors)
    if written:
        print(f"{time.strftime('%F %T')} backfilled {written} missed by the socket")
    return failed


if __name__ == "__main__":
    try:
        failed = main()
    except Exception as exc:
        health("slack-poll", "Slack 定时补读", 600, error=exc)
        print(f"{time.strftime('%F %T')} slack poll failed: {exc}", file=sys.stderr)
        sys.exit(1)
    health("slack-poll", "Slack 定时补读", 600, error="; ".join(failed) if failed else None, partial=True)
    if failed:
        print(f"{time.strftime('%F %T')} slack poll: some places could not be read: {'; '.join(failed)}", file=sys.stderr)
        sys.exit(1)

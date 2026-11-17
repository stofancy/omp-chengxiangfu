"""定时轮询（建议每 5 分钟）：你自己开着的 PR 有别人的新评论、review 或投票，就写成外部消息。只读。

GitHub 走 gh CLI；Azure DevOps 走 az CLI，只有 config.json 里配了 ado.org 才查。
第一次运行只记下当前位置。按 PR 标题开头的卡号归到一条线（config.json 的 line_pattern）。
"""
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

from inbox import CONFIG, line_of, load_state, save_state, write_event

ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"  # Azure DevOps 的 AAD 资源 ID，固定值
VOTES = {10: "approved", 5: "approved with suggestions", 0: "no vote", -5: "waiting for author", -10: "rejected"}


def run_json(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=90)
    if p.returncode:
        raise RuntimeError(f"{args[0]} {args[1]} exit {p.returncode}: {p.stderr.strip()[-300:]}")
    return json.loads(p.stdout or "null")


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def github(state):
    me = state.get("gh_me") or state.setdefault("gh_me", run_json(["gh", "api", "user"])["login"])
    seen = state.setdefault("gh", {})
    prs = run_json(["gh", "search", "prs", "--author=@me", "--state=open", "--limit", "50", "--json", "url,number,repository,title,updatedAt"])
    for pr in prs:
        url, since = pr["url"], seen.get(pr["url"])
        if since is None:
            seen[url] = iso_now()
            continue
        if pr["updatedAt"] <= since:
            continue
        repo, n = pr["repository"]["nameWithOwner"], pr["number"]
        where = f"{repo}#{n} {pr['title'][:60]}"
        hits = []
        for c in run_json(["gh", "api", f"repos/{repo}/issues/{n}/comments?since={since}&per_page=100"]):
            hits.append((c["created_at"], c["user"]["login"], c["html_url"], "comment"))
        for c in run_json(["gh", "api", f"repos/{repo}/pulls/{n}/comments?since={since}&per_page=100"]):
            hits.append((c["created_at"], c["user"]["login"], c["html_url"], "review comment"))
        for r in run_json(["gh", "api", f"repos/{repo}/pulls/{n}/reviews?per_page=100"]):
            hits.append((r.get("submitted_at") or "", r["user"]["login"], r["html_url"], f"review {r['state']}"))
        newest = since
        for at, who, link, kind in sorted(hits):
            if at <= since:
                continue
            newest = max(newest, at)
            if who != me:
                write_event("github", who, where, link, line=line_of(pr["title"]), note=kind)
        seen[url] = max(newest, pr["updatedAt"])


def ado(state, org):
    base = f"https://dev.azure.com/{org}"
    rest = ["az", "rest", "--resource", ADO_RESOURCE, "--url"]
    me = state.get("ado_me") or state.setdefault("ado_me", run_json([*rest, f"https://vssps.dev.azure.com/{org}/_apis/connectionData"])["authenticatedUser"]["id"])
    seen = state.setdefault("ado", {})
    prs = run_json([*rest, f"{base}/_apis/git/pullrequests?searchCriteria.creatorId={me}&searchCriteria.status=active&api-version=7.1"])["value"]
    for pr in prs:
        proj, repo, pid = pr["repository"]["project"]["name"], pr["repository"], pr["pullRequestId"]
        key = f"{proj}/{repo['name']}/{pid}"
        link = f"{base}/{proj}/_git/{repo['name']}/pullrequest/{pid}"
        where = f"{repo['name']}!{pid} {pr['title'][:60]}"
        votes = {r["displayName"]: r.get("vote", 0) for r in pr.get("reviewers", []) if r.get("id") != me}
        prev = seen.get(key)
        if prev is None:
            seen[key] = {"since": iso_now(), "votes": votes}
            continue
        for name, vote in votes.items():
            if prev["votes"].get(name, 0) != vote:
                write_event("ado", name, where, link, line=line_of(pr["title"]), note=f"vote: {VOTES.get(vote, vote)}")
        since, newest = prev["since"], prev["since"]
        threads = run_json([*rest, f"{base}/{proj}/_apis/git/repositories/{repo['id']}/pullRequests/{pid}/threads?api-version=7.1"])["value"]
        for t in threads:
            for c in t.get("comments", []):
                at = (c.get("publishedDate") or "")[:19] + "Z"
                if at <= since or c.get("commentType") == "system":
                    continue
                newest = max(newest, at)
                if c.get("author", {}).get("id") != me:
                    write_event("ado", c["author"].get("displayName", "?"), where, f"{link}?discussionId={t['id']}", line=line_of(pr["title"]), note="comment")
        seen[key] = {"since": newest, "votes": votes}


def main():
    state = load_state("pr.json", {})
    jobs = [("github", lambda: github(state))]
    if CONFIG.get("ado", {}).get("org"):
        jobs.append(("ado", lambda: ado(state, CONFIG["ado"]["org"])))
    failed = []
    for name, job in jobs:
        try:
            job()
        except Exception as exc:  # 一边失败不影响另一边；游标只在成功的那边前进
            failed.append(f"{name}: {exc}")
    save_state("pr.json", state)
    if failed:
        print(f"{time.strftime('%F %T')} pr poll failed: {'; '.join(failed)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

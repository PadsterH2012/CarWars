#!/usr/bin/env python3
"""CarWars GitHub issue watchman — run every 4h to triage issues.
Runs on Paddy's Mac. Reads PAT from local Obsidian file."""
import json, sys, re, base64, urllib.request
from datetime import datetime, timezone, timedelta

def parse_gh_date(s):
    """Parse GitHub date string safely, returns offset-aware datetime."""
    s = s.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
        # If it parsed as date-only, promote to midnight UTC
        if not isinstance(dt, datetime):
            dt = datetime.combine(dt, datetime.min.time()).replace(tzinfo=timezone.utc)
        # If it's naive, assume UTC
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except:
        return datetime.now(timezone.utc) - timedelta(days=999)

# ── Step 1: Read PAT from local project_info.md ──
pat_path = "/Volumes/Breakaway/obsidian/Homelab/Projects/A1 - Main Projects/CarWars/project_info.md"
with open(pat_path) as f:
    content = f.read()

m = re.search(r"Pat Token\s+\|\s+(\S+)", content)
if not m:
    print("ERROR: Pat Token not found in project_info.md")
    sys.exit(1)

token = m.group(1)
if not token.startswith("ghp_") or len(token) < 40:
    print(f"TOKEN ERROR: bad token (len={len(token)})")
    # Try base64 decode in case it's encoded
    try:
        token = base64.b64decode(token).decode()
    except:
        print(f"  Raw: {repr(token)}")
        sys.exit(1)

# ── Step 2: Fetch all issues ──
headers = {
    "Authorization": f"token {token}",
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "Amber-CarWars-Watchman"
}
url = "https://api.github.com/repos/PadsterH2012/CarWars/issues?state=all&per_page=30"

req = urllib.request.Request(url, headers=headers)
resp = urllib.request.urlopen(req, timeout=15)
issues = json.loads(resp.read().decode())

print(f"=== CarWars GitHub Issue Watchman ===")
print(f"Total issues found: {len(issues)}")
print()

now = datetime.now(timezone.utc)
flagged_issues = []

for issue in issues:
    if "pull_request" in issue:
        continue
    
    num = issue["number"]
    state = issue["state"]
    title = issue["title"]
    labels = [l["name"] for l in issue["labels"]]
    body = issue.get("body", "") or ""
    updated = issue["updated_at"][:10]
    created = issue["created_at"][:10]
    comments = issue["comments"]
    
    print(f"#{num} [{state}] {title}")
    print(f"   Labels: {', '.join(labels) if labels else '(none)'}")
    print(f"   Created: {created} | Updated: {updated} | Comments: {comments}")
    
    # ── Triage: missing detail ──
    needs_detail = []
    
    if not body.strip():
        needs_detail.append("Empty description")
    
    if "bug" in [l.lower() for l in labels]:
        has_steps = any(kw in body.lower() for kw in [
            "steps to reproduce", "steps to recreate", "how to reproduce"
        ])
        has_expected = any(kw in body.lower() for kw in [
            "expected behaviour", "expected behavior", "expected result"
        ])
        if not has_steps:
            needs_detail.append("Bug: no steps to reproduce")
        if not has_expected:
            needs_detail.append("Bug: no expected behaviour")
    
    if needs_detail:
        body_preview = body.strip()[:80].replace("\n", " ")
        print(f"   ⚠️  Missing detail: {'; '.join(needs_detail)}")
        print(f"       Body preview: \"{body_preview}...\"")
        flagged_issues.append(num)
    
    # ── Staleness check ──
    if state == "open":
        updated_dt = parse_gh_date(updated)
        days = (now - updated_dt).days
        if days > 30:
            print(f"   ⏰ Stale: {days} days since last update (created {created})")
            flagged_issues.append(num)
    
    # ── Phase reference check ──
    for phase_word in ["Phase 1", "Phase 2", "Phase 3"]:
        if phase_word in title or phase_word in body:
            print(f"   🔍 References {phase_word}")
    
    print()

# ── Summary for notification ──
open_issues = [i for i in issues if i["state"] == "open" and "pull_request" not in i]

print(f"\n=== Summary ===")
print(f"Open issues: {len(open_issues)}")
if flagged_issues:
    print(f"Flagged issues: #{', #'.join(str(n) for n in set(flagged_issues))}")
    print(f"ACTION_REQUIRED: yes")
else:
    print(f"All issues healthy. Nothing flagged.")
    print(f"ACTION_REQUIRED: no")
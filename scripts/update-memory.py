#!/usr/bin/env python3
"""
Daily memory updater for ClashControl.

Reads MEMORY.md, fetches recent git commits, generates a session summary
(using Claude API if ANTHROPIC_API_KEY is set, else plain commit list),
prepends the entry to the session log, and prunes entries older than
MAX_SESSION_LOG_DAYS. Every pruned entry is recorded in the cleanup log
with the reason.

Usage:
    python3 scripts/update-memory.py          # normal run
    python3 scripts/update-memory.py --force  # re-run even if already updated today
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).parent.parent
MEMORY_FILE = REPO_ROOT / "MEMORY.md"
VERSION_FILE = REPO_ROOT / "version.json"
MAX_SESSION_LOG_DAYS = 60   # entries older than this are pruned
MAX_ACTIVE_STALE_DAYS = 14  # flag active-work items untouched for this long
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MODEL = "claude-sonnet-4-6"
FORCE = "--force" in sys.argv

# ── Section helpers ──────────────────────────────────────────────────────────
SECTION_RE = re.compile(r"<!-- BEGIN:(\S+) -->(.*?)<!-- END:\1 -->", re.DOTALL)


def parse_sections(content: str) -> dict:
    return {m.group(1): m.group(2).strip() for m in SECTION_RE.finditer(content)}


def replace_section(content: str, name: str, new_body: str) -> str:
    replacement = f"<!-- BEGIN:{name} -->\n{new_body}\n<!-- END:{name} -->"
    pattern = re.compile(
        rf"<!-- BEGIN:{re.escape(name)} -->.*?<!-- END:{re.escape(name)} -->",
        re.DOTALL,
    )
    if pattern.search(content):
        return pattern.sub(replacement, content)
    # Section missing — append it
    return content.rstrip() + f"\n\n{replacement}\n"


# ── Git helpers ──────────────────────────────────────────────────────────────
def git(*args) -> str:
    return subprocess.run(
        ["git", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    ).stdout.strip()


def commits_since(iso_timestamp: str) -> str:
    """Return one-line commit log since iso_timestamp, newest first."""
    return git("log", f"--since={iso_timestamp}", "--oneline", "--no-merges")


def last_session_date(session_log: str) -> str | None:
    """Return YYYY-MM-DD of the most recent session entry, or None."""
    m = re.search(r"### (\d{4}-\d{2}-\d{2})", session_log)
    return m.group(1) if m else None


# ── Claude API ───────────────────────────────────────────────────────────────
def call_claude(prompt: str, max_tokens: int = 1200) -> str | None:
    if not ANTHROPIC_API_KEY:
        return None
    payload = json.dumps({
        "model": MODEL,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read())
            return data["content"][0]["text"].strip()
    except Exception as e:
        print(f"[update-memory] Claude API error: {e}", file=sys.stderr)
        return None


# ── Summary generation ───────────────────────────────────────────────────────
def generate_session_entry(today: str, commits: str, memory_snapshot: str) -> str:
    """Generate a session log entry — via Claude if possible, else plain."""
    if ANTHROPIC_API_KEY:
        prompt = f"""You are the automated memory keeper for ClashControl, an open-source IFC clash detection web app.

Today is {today}.

Git commits since the last daily update (newest first):
{commits}

Current MEMORY.md (first 3000 chars for context):
{memory_snapshot[:3000]}

Write a SINGLE daily session log entry in this EXACT format (no extra text before or after):

### {today}
**Summary:** [1-2 sentences describing what changed]
**Changed:** [comma-separated list of areas touched, e.g. "2D sheet, walk mode, API"]
**Notable:** [one thing future sessions should remember — a decision, a fix, a gotcha — or "—" if nothing stands out]

Be concise. 4–6 lines total. Do not add headings, preamble, or commentary outside the entry."""
        result = call_claude(prompt)
        if result:
            # Verify it starts with our heading
            if result.startswith(f"### {today}"):
                return result
            # Try to extract just the entry if Claude added preamble
            m = re.search(rf"(### {today}.*)", result, re.DOTALL)
            if m:
                return m.group(1).strip()

    # Fallback: plain commit list
    commit_lines = "\n".join(f"- {line}" for line in commits.splitlines() if line.strip())
    count = len([l for l in commits.splitlines() if l.strip()])
    return (
        f"### {today}\n"
        f"**Summary:** {count} commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).\n"
        f"**Changed:** see commits\n"
        f"**Notable:** —\n\n"
        f"<details><summary>Commits</summary>\n\n{commit_lines}\n\n</details>"
    )


# ── Version header sync ───────────────────────────────────────────────────────
def read_app_version() -> str | None:
    """Return 'major.minor.patch[-label]' from version.json, or None."""
    try:
        v = json.loads(VERSION_FILE.read_text())
        ver = f"{v['major']}.{v['minor']}.{v['patch']}"
        if v.get("label"):
            ver += f"-{v['label']}"
        return ver
    except Exception as e:
        print(f"[update-memory] could not read version.json: {e}", file=sys.stderr)
        return None


def refresh_project_state_version(content: str, today: str) -> str:
    """
    Keep the Project State `**Version:**` line in sync with version.json.
    The version-bump workflow advances version.json on every merge, so this
    header drifts otherwise. Only the date is refreshed when the number
    actually changes (so an unchanged version keeps its original date).
    """
    ver = read_app_version()
    if not ver:
        return content

    def repl(m: re.Match) -> str:
        if m.group(1) == ver:
            return m.group(0)  # unchanged — keep existing date
        return f"**Version:** {ver} ({today})"

    new_content, _ = re.subn(
        r"\*\*Version:\*\*\s*([0-9][^\s(]*)\s*\([^)]*\)", repl, content, count=1
    )
    return new_content


# ── Active work freshness check ──────────────────────────────────────────────
def flag_stale_active_work(active_work: str, today: str) -> str:
    """
    Mark active-work items with [STALE?] if they have an untouched
    date marker older than MAX_ACTIVE_STALE_DAYS.  Conservative — only
    lines that already carry a YYYY-MM-DD date are touched.
    """
    cutoff = (
        datetime.fromisoformat(today) - timedelta(days=MAX_ACTIVE_STALE_DAYS)
    ).strftime("%Y-%m-%d")

    def mark_line(line: str) -> str:
        m = re.search(r"(\d{4}-\d{2}-\d{2})", line)
        if m and m.group(1) < cutoff and "[STALE?]" not in line and "~~" not in line:
            return line.rstrip() + "  **[STALE?]**"
        return line

    return "\n".join(mark_line(l) for l in active_work.splitlines())


# ── Pruning ──────────────────────────────────────────────────────────────────
def prune_session_log(
    session_log: str, cutoff_date: str
) -> tuple[str, list[tuple[str, str]]]:
    """
    Split session log on ### headings. Keep entries >= cutoff_date.
    Return (kept_log, [(date, full_entry_text), ...]) for removed ones.
    """
    # Split preserving delimiters
    chunks = re.split(r"(?=### \d{4}-\d{2}-\d{2})", session_log)
    kept: list[str] = []
    removed: list[tuple[str, str]] = []

    for chunk in chunks:
        m = re.match(r"### (\d{4}-\d{2}-\d{2})", chunk)
        if m:
            if m.group(1) >= cutoff_date:
                kept.append(chunk)
            else:
                removed.append((m.group(1), chunk.strip()))
        else:
            # Preamble text before the first entry — always keep
            kept.append(chunk)

    return "".join(kept).strip(), removed


def build_cleanup_additions(today: str, removed: list[tuple[str, str]]) -> str:
    lines = []
    for entry_date, _ in removed:
        lines.append(
            f"### {today} — pruned session entry {entry_date}\n"
            f"**Reason:** Entry is older than {MAX_SESSION_LOG_DAYS} days."
        )
    return "\n\n".join(lines)


# ── Main ─────────────────────────────────────────────────────────────────────
def main() -> None:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=MAX_SESSION_LOG_DAYS)
    ).strftime("%Y-%m-%d")

    if not MEMORY_FILE.exists():
        print("[update-memory] MEMORY.md not found — skipping.", file=sys.stderr)
        sys.exit(1)

    content = MEMORY_FILE.read_text()

    # Keep the Project State version header in sync with version.json,
    # independent of commit activity (the version-bump workflow may have
    # advanced it since the last sync).
    refreshed = refresh_project_state_version(content, today)
    version_changed = refreshed != content
    content = refreshed

    sections = parse_sections(content)
    session_log = sections.get("session-log", "")

    # Skip if already updated today (unless --force)
    last_date = last_session_date(session_log)
    if last_date == today and not FORCE:
        if version_changed:
            MEMORY_FILE.write_text(content)
            print("[update-memory] Version header synced from version.json.")
        print(f"[update-memory] Already updated for {today}. Use --force to re-run.")
        return

    # Determine since-timestamp
    since_ts = f"{last_date}T00:00:00" if last_date else (
        datetime.now(timezone.utc) - timedelta(hours=25)
    ).strftime("%Y-%m-%dT%H:%M:%S")

    commits = commits_since(since_ts)
    if not commits:
        if version_changed:
            MEMORY_FILE.write_text(content)
            print("[update-memory] Version header synced from version.json.")
        print(f"[update-memory] No new commits since {since_ts} — skipping.")
        return

    print(f"[update-memory] {len(commits.splitlines())} new commit(s) since {since_ts}.")

    # Generate session entry
    new_entry = generate_session_entry(today, commits, content)
    print(f"[update-memory] Session entry generated.")

    # Prepend to session log (strip old "today" entry when --force)
    if FORCE and last_date == today:
        session_log = re.sub(rf"### {today}.*?(?=### \d{{4}}|\Z)", "", session_log, flags=re.DOTALL).strip()

    updated_log = new_entry.strip() + "\n\n" + session_log if session_log.strip() else new_entry.strip()

    # Prune old entries
    pruned_log, removed = prune_session_log(updated_log, cutoff)
    if removed:
        print(f"[update-memory] Pruned {len(removed)} old session log entries (>{MAX_SESSION_LOG_DAYS} days).")

    # Flag stale active work
    active_work = sections.get("active-work", "")
    if active_work:
        updated_active = flag_stale_active_work(active_work, today)
        if updated_active != active_work:
            print("[update-memory] Flagged stale active-work items.")
            content = replace_section(content, "active-work", updated_active)

    # Update session log
    content = replace_section(content, "session-log", pruned_log)

    # Append pruned entries to cleanup log
    if removed:
        cleanup_log = sections.get("cleanup-log", "_Nothing pruned yet._")
        additions = build_cleanup_additions(today, removed)
        if cleanup_log.strip() == "_Nothing pruned yet._":
            cleanup_log = additions
        else:
            cleanup_log = additions + "\n\n" + cleanup_log
        content = replace_section(content, "cleanup-log", cleanup_log)

    MEMORY_FILE.write_text(content)
    print(f"[update-memory] MEMORY.md updated for {today}. Done.")


if __name__ == "__main__":
    main()

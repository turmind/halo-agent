#!/usr/bin/env python3
"""
manage-cron — CRUD + listing for the global cron-jobs db.

Skill helper: agents call this rather than handcrafting sqlite3 queries.
The script handles id generation, JSON encoding for `targets`, schedule
validation hint (we leave the actual cron parse to the runner), and
keeps `updated_at` fresh.

Server's cron daemon polls cron_jobs every 10 seconds, so any change
made here goes live within ~10s without a server restart.

Output is always JSON on stdout for easy parsing. Errors go to stderr
with non-zero exit.

Subcommands:
  list [--chat-id <id>]         → list all jobs (sorted by createdAt desc).
                                  --chat-id filters to jobs that push to that
                                  chat — useful for "delete my cron" inside a
                                  channel where the agent only knows the
                                  current chatId.
  get <id>                      → one job + last 5 runs
  create <args>                 → insert a new job, prints the generated id
  update <id> <args>            → patch an existing job
  enable <id> / disable <id>    → toggle the `enabled` flag
  delete <id>                   → remove the job and its run history
  channels                      → list bound channel accounts that can be
                                  used as cron targets (for `--targets`)
  runs <jobId> [--limit N] [--before <runId>]
                                → run history, cursor-paginated by runId
                                  (which is an ISO timestamp = sort order)

`--targets` arg: comma-separated `channelType:accountId` pairs.
  example: `--targets telegram:halo_agent_bot,wechat:alice`

`--active-from` / `--active-until` (recurring jobs only): the schedule fires
only inside [from, until); fires outside it are skipped silently. Accepts
YYYY-MM-DD, ISO-8601 or unix ms; a time without offset is read in the job's
timezone. A bare date means that day 00:00 for --active-from and the NEXT
day 00:00 for --active-until (so the date itself is included). `""` clears.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

DB = Path.home() / '.halo' / 'global' / 'cron.db'
CHANNELS_DB = Path.home() / '.halo' / 'secrets' / 'channels' / 'channels.db'


def open_db() -> sqlite3.Connection:
    if not DB.exists():
        die(f'cron db not found at {DB}; is the halo server running and initialized?')
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    return conn


def die(msg: str, code: int = 1):
    sys.stderr.write(f'error: {msg}\n')
    sys.exit(code)


def now_ms() -> int:
    return int(time.time() * 1000)


def gen_job_id() -> str:
    """Match the admin route's id format: cron-<timestamp36>-<rand6>."""
    import random
    import string
    ts = format(int(time.time() * 1000), 'x')[-8:]
    rand = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f'cron-{ts}-{rand}'


def parse_targets(raw: str) -> list[dict]:
    """`telegram:bot1,wechat:user2` → [{channelType, accountId}, ...].

    Optional explicit chat id: `telegram:bot1:12345` — useful when the
    cron was created from inside a chat and should keep replying there
    instead of fanning out to every whitelisted user. Accepted forms:

      telegram:bot1                  → fan-out (telegram allowedUsers)
      telegram:bot1:12345            → only chat 12345
      wechat:owner_id                → bot owner (QR-bind userId)
      wechat:owner_id:o123           → only that openId

    Also accepts a JSON array for callers that want to set complex shapes.
    """
    raw = raw.strip()
    if not raw:
        return []
    if raw.startswith('['):
        return json.loads(raw)
    out = []
    for token in raw.split(','):
        token = token.strip()
        if not token:
            continue
        if ':' not in token:
            die(f'invalid target "{token}": expected "channelType:accountId[:chatId]"')
        parts = token.split(':', 2)
        ct, aid = parts[0].strip(), parts[1].strip()
        item: dict = {'channelType': ct, 'accountId': aid}
        if len(parts) == 3 and parts[2].strip():
            item['chatId'] = parts[2].strip()
        out.append(item)
    return out


def parse_timeout_sec(raw: str | None) -> int | None:
    """Validate --timeout-sec: integer seconds, 60–21600 (same bounds as the
    admin REST routes). None = leave unset (runner default 3600)."""
    if raw is None or not raw.strip():
        return None
    try:
        v = int(raw.strip())
    except ValueError:
        die(f'invalid --timeout-sec "{raw}": expected an integer (seconds)')
    if v < 60 or v > 21600:
        die('--timeout-sec must be between 60 and 21600')
    return v


SESSION_ID_RE = re.compile(r'^[A-Za-z0-9_:-]{1,200}$')


def parse_session(raw: str | None) -> str | None:
    """Validate --session: a root session id (same rule as the admin REST
    routes — no `>` sub-session path). Empty = None = the job's own session
    (same id as the job)."""
    if raw is None or not raw.strip():
        return None
    v = raw.strip()
    if not SESSION_ID_RE.match(v):
        die(f'invalid --session "{raw}": expected a root session id (letters, digits, _ : - only; no ">" sub-session path)')
    return v


def parse_run_at(raw: str | None) -> int | None:
    """Accepts ISO-8601 (`2026-05-24T09:00:00`) or a unix-ms integer; returns
    epoch ms or None. Local time without offset is parsed as host TZ —
    same convention as `datetime.fromisoformat`."""
    if not raw:
        return None
    raw = raw.strip()
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)
    from datetime import datetime
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        die(f'invalid --run-at "{raw}": expected ISO-8601 (e.g. 2026-05-24T09:00) or unix ms')
    if dt.tzinfo is None:
        dt = dt.astimezone()  # treat as host-local
    return int(dt.timestamp() * 1000)


DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def _tzinfo(tz_name: str | None):
    """ZoneInfo for an IANA name; None for unset or unknown names."""
    if not tz_name:
        return None
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def job_tz(tz_name: str | None):
    """tzinfo for the job's timezone; None = host-local."""
    tz = _tzinfo(tz_name)
    if tz_name and tz is None:
        die(f'unknown timezone "{tz_name}"; expected an IANA name like Asia/Shanghai')
    return tz


def parse_active_bound(flag: str, raw: str, tz_name: str | None) -> int | None:
    """Parse --active-from / --active-until into epoch ms; "" = None (clear).

    YYYY-MM-DD → that day 00:00 (from) or the NEXT day 00:00 (until, so the
    date is included). ISO without offset / bare dates are read in the job's
    timezone (host-local when the job has none)."""
    raw = raw.strip()
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)
    from datetime import datetime, timedelta
    tz = job_tz(tz_name)
    if DATE_RE.match(raw):
        try:
            dt = datetime.strptime(raw, '%Y-%m-%d')
        except ValueError:
            die(f'invalid {flag} "{raw}": not a calendar date')
        if flag == '--active-until':
            dt += timedelta(days=1)
    else:
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            die(f'invalid {flag} "{raw}": expected YYYY-MM-DD, ISO-8601 (e.g. 2026-10-08T09:00) or unix ms')
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz) if tz else dt.astimezone()
    return int(dt.timestamp() * 1000)


def validate_active_window(run_at, active_from, active_until, new_until: bool):
    """Same rules as the admin REST routes, on the merged row: recurring jobs
    only; a newly set --active-until must be in the future and after from."""
    if active_from is None and active_until is None:
        return
    if run_at is not None:
        die('--active-from/--active-until only apply to recurring jobs, not --run-at one-shots '
            '(on update, clear them with --active-from "" --active-until "")')
    if new_until and active_until is not None and active_until <= now_ms():
        die('--active-until must be in the future')
    if active_from is not None and active_until is not None and active_until <= active_from:
        die('--active-until must be after --active-from')


def require_active_columns(conn: sqlite3.Connection):
    """cron.db gains active_from/active_until via the server's boot migration;
    a server that hasn't restarted onto this version yet won't have them."""
    cols = {r[1] for r in conn.execute('PRAGMA table_info(cron_jobs)').fetchall()}
    if 'active_from' not in cols or 'active_until' not in cols:
        die('cron.db has no active_from/active_until columns yet — restart the halo server '
            'once so it migrates cron.db, then retry')


def ms_to_iso(ms, tz_name: str | None) -> str | None:
    if ms is None:
        return None
    from datetime import datetime
    tz = _tzinfo(tz_name)  # display only — never die on a stored bad tz
    dt = datetime.fromtimestamp(ms / 1000, tz=tz) if tz else datetime.fromtimestamp(ms / 1000).astimezone()
    return dt.isoformat(timespec='minutes')


def row_to_job(row: sqlite3.Row) -> dict:
    j = dict(row)
    try:
        j['targets'] = json.loads(j.get('targets') or '[]')
    except Exception:
        j['targets'] = []
    j['enabled'] = bool(j['enabled'])
    # Active window: ms (as stored) + ISO in the job's timezone. Pre-migration
    # dbs have no columns — report them as unset.
    for k in ('active_from', 'active_until'):
        j.setdefault(k, None)
        j[f'{k}_iso'] = ms_to_iso(j[k], j.get('timezone'))
    return j


# ── subcommand impls ──────────────────────────────────────────────────


def cmd_list(args):
    conn = open_db()
    rows = conn.execute(
        'SELECT * FROM cron_jobs ORDER BY created_at DESC'
    ).fetchall()
    jobs = [row_to_job(r) for r in rows]
    # Filter to jobs whose targets push to this chat — used by the
    # in-channel "delete my cron" / "list my crons" flow, where the
    # agent only knows the current chatId and needs to find which
    # cron_jobs reference it. chatId formats don't collide across
    # channels (telegram numeric, slack D…/C…, feishu oc_…, wecom userid/chatid, wechat o…)
    # so a single chatId match is unambiguous.
    if args.chat_id:
        jobs = [
            j for j in jobs
            if any((t.get('chatId') or '') == args.chat_id for t in j.get('targets') or [])
        ]
    print(json.dumps(jobs, ensure_ascii=False, indent=2))


def cmd_get(args):
    conn = open_db()
    row = conn.execute(
        'SELECT * FROM cron_jobs WHERE id = ?', (args.id,)
    ).fetchone()
    if not row:
        die(f'job {args.id} not found', 2)
    job = row_to_job(row)
    runs = conn.execute(
        'SELECT id, status, started_at, completed_at, exit_code, failure_reason '
        'FROM cron_runs WHERE job_id = ? ORDER BY id DESC LIMIT 5',
        (args.id,),
    ).fetchall()
    job['recentRuns'] = [dict(r) for r in runs]
    print(json.dumps(job, ensure_ascii=False, indent=2))


def cmd_create(args):
    if not args.workspace:
        die('--workspace required')
    if not args.prompt:
        die('--prompt required')
    has_schedule = bool(args.schedule and args.schedule.strip())
    run_at_ms = parse_run_at(args.run_at)
    if not has_schedule and run_at_ms is None:
        die('--schedule or --run-at required')
    if has_schedule and run_at_ms is not None:
        die('--schedule and --run-at are mutually exclusive')
    if run_at_ms is not None and run_at_ms <= now_ms():
        die('--run-at must be in the future')
    timeout_sec = parse_timeout_sec(args.timeout_sec)
    session_id = parse_session(args.session)
    active_from = parse_active_bound('--active-from', args.active_from or '', args.timezone)
    active_until = parse_active_bound('--active-until', args.active_until or '', args.timezone)
    validate_active_window(run_at_ms, active_from, active_until, new_until=True)

    job_id = args.id or gen_job_id()
    now = now_ms()
    targets = parse_targets(args.targets) if args.targets else []

    conn = open_db()
    existing = conn.execute('SELECT 1 FROM cron_jobs WHERE id = ?', (job_id,)).fetchone()
    if existing:
        die(f'job id {job_id} already exists; pick another with --id', 2)

    values: dict[str, object] = {
        'id': job_id,
        'label': args.label,
        'workspace_path': args.workspace,
        'agent_id': args.agent or 'default',
        'user_prompt': args.prompt,
        'schedule': args.schedule or '',
        'run_at': run_at_ms,
        'timezone': args.timezone,
        'timeout_sec': timeout_sec,
        'session_id': session_id,
        'targets': json.dumps(targets, ensure_ascii=False),
        'enabled': 0 if args.disabled else 1,
        'created_at': now,
        'updated_at': now,
    }
    # Only name the window columns when used, so jobs without a window can
    # still be created on a cron.db the server hasn't migrated yet.
    if active_from is not None or active_until is not None:
        require_active_columns(conn)
        values['active_from'] = active_from
        values['active_until'] = active_until
    conn.execute(
        f'INSERT INTO cron_jobs({", ".join(values)}) VALUES ({", ".join("?" for _ in values)})',
        list(values.values()),
    )
    conn.commit()
    print(json.dumps({'id': job_id, 'created': True}, ensure_ascii=False))


def cmd_update(args):
    conn = open_db()
    row = conn.execute('SELECT * FROM cron_jobs WHERE id = ?', (args.id,)).fetchone()
    if not row:
        die(f'job {args.id} not found', 2)

    sets: list[tuple[str, object]] = []
    if args.label is not None: sets.append(('label', args.label))
    if args.workspace is not None: sets.append(('workspace_path', args.workspace))
    if args.agent is not None: sets.append(('agent_id', args.agent))
    if args.prompt is not None: sets.append(('user_prompt', args.prompt))
    if args.schedule is not None: sets.append(('schedule', args.schedule))
    if args.run_at is not None:
        run_at_ms = parse_run_at(args.run_at)
        if run_at_ms is not None and run_at_ms <= now_ms():
            die('--run-at must be in the future')
        sets.append(('run_at', run_at_ms))
    if args.timezone is not None: sets.append(('timezone', args.timezone))
    if args.timeout_sec is not None:
        # `--timeout-sec ""` clears back to the runner default (NULL),
        # same convention as `--run-at ""`.
        sets.append(('timeout_sec', parse_timeout_sec(args.timeout_sec)))
    if args.session is not None:
        # `--session ""` clears back to the job's own session (id = job id).
        sets.append(('session_id', parse_session(args.session)))
    if args.targets is not None:
        sets.append(('targets', json.dumps(parse_targets(args.targets), ensure_ascii=False)))
    cur = dict(row)
    if args.active_from is not None or args.active_until is not None:
        require_active_columns(conn)
        # Bare dates / offset-less times read in the job's timezone after
        # this update: the new --timezone if given, else the stored one.
        tz = args.timezone if args.timezone is not None else cur.get('timezone')
        if args.active_from is not None:
            sets.append(('active_from', parse_active_bound('--active-from', args.active_from, tz)))
        if args.active_until is not None:
            sets.append(('active_until', parse_active_bound('--active-until', args.active_until, tz)))
    # Window rules on the merged row (also catches --run-at on a job that
    # still has a window).
    merged = {**cur, **dict(sets)}
    validate_active_window(
        merged.get('run_at'), merged.get('active_from'), merged.get('active_until'),
        new_until=bool(args.active_until and args.active_until.strip()),
    )
    if not sets:
        die('nothing to update — pass at least one --label/--workspace/--agent/--prompt/--schedule/--run-at/--timezone/--timeout-sec/--session/--targets/--active-from/--active-until')
    sets.append(('updated_at', now_ms()))

    placeholders = ', '.join(f'{k} = ?' for k, _ in sets)
    values = [v for _, v in sets] + [args.id]
    conn.execute(f'UPDATE cron_jobs SET {placeholders} WHERE id = ?', values)
    conn.commit()
    print(json.dumps({'id': args.id, 'updated': True}, ensure_ascii=False))


def cmd_enable(args):
    _toggle_enabled(args.id, True)


def cmd_disable(args):
    _toggle_enabled(args.id, False)


def _toggle_enabled(job_id: str, on: bool):
    conn = open_db()
    cur = conn.execute(
        'UPDATE cron_jobs SET enabled = ?, updated_at = ? WHERE id = ?',
        (1 if on else 0, now_ms(), job_id),
    )
    if cur.rowcount == 0:
        die(f'job {job_id} not found', 2)
    conn.commit()
    print(json.dumps({'id': job_id, 'enabled': on}, ensure_ascii=False))


def cmd_delete(args):
    conn = open_db()
    cur = conn.execute('DELETE FROM cron_jobs WHERE id = ?', (args.id,))
    if cur.rowcount == 0:
        die(f'job {args.id} not found', 2)
    conn.execute('DELETE FROM cron_runs WHERE job_id = ?', (args.id,))
    conn.commit()
    print(json.dumps({'id': args.id, 'deleted': True}, ensure_ascii=False))


def cmd_channels(_):
    """List channel accounts that can be referenced as cron targets.

    Mirrors the admin /api/cron/channel-targets endpoint:
    telegram = ok if numeric id in allowedUsers OR a cached
    lastActiveChatId; wechat = ok if account.userId (QR-bind owner)
    OR cached lastActiveChatId.
    """
    if not CHANNELS_DB.exists():
        print(json.dumps([], ensure_ascii=False))
        return
    conn = sqlite3.connect(str(CHANNELS_DB))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT account_id, channel_type, label, enabled, workspace_path, config "
        "FROM channel_accounts WHERE enabled = 1"
    ).fetchall()
    out = []
    import re
    for r in rows:
        try:
            cfg = json.loads(r['config'] or '{}')
        except Exception:
            cfg = {}
        last = cfg.get('lastActiveChatId')
        ct = r['channel_type']
        if ct == 'telegram':
            allowed = cfg.get('allowedUsers') or ''
            has_whitelist_id = bool(re.search(r'\b-?\d+\b', allowed))
            ready = has_whitelist_id or bool(last)
        elif ct == 'wechat':
            owner = cfg.get('userId')
            ready = bool(owner) or bool(last)
        else:
            ready = bool(last)
        out.append({
            'channelType': ct,
            'accountId': r['account_id'],
            'label': r['label'] or r['account_id'],
            'workspacePath': r['workspace_path'],
            'ready': ready,
        })
    print(json.dumps(out, ensure_ascii=False, indent=2))


def cmd_runs(args):
    conn = open_db()
    sql = (
        'SELECT id, job_id, trigger_kind, status, started_at, completed_at, '
        'exit_code, failure_reason, output, dispatch_results '
        'FROM cron_runs WHERE job_id = ?'
    )
    params: list[object] = [args.job_id]
    if args.before:
        # runId is `<isoTimestamp>-<rand>`, sortable as a string. id < cursor
        # is the "older than" check for descending pagination.
        sql += ' AND id < ?'
        params.append(args.before)
    sql += ' ORDER BY id DESC LIMIT ?'
    params.append(args.limit + 1)  # fetch one extra to detect hasMore
    rows = conn.execute(sql, params).fetchall()
    has_more = len(rows) > args.limit
    rows = rows[:args.limit]
    runs = []
    for r in rows:
        d = dict(r)
        try:
            d['dispatch_results'] = json.loads(d['dispatch_results']) if d['dispatch_results'] else None
        except Exception:
            pass
        runs.append(d)
    out = {
        'runs': runs,
        'hasMore': has_more,
        'nextCursor': runs[-1]['id'] if has_more and runs else None,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


# ── argparse ──────────────────────────────────────────────────────────


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)

    ls = sub.add_parser('list')
    ls.add_argument('--chat-id', dest='chat_id',
                    help='filter to jobs that push to this chat id (use {{channel.chat_id}} from inside a chat)')
    ls.set_defaults(func=cmd_list)

    g = sub.add_parser('get')
    g.add_argument('id')
    g.set_defaults(func=cmd_get)

    c = sub.add_parser('create')
    c.add_argument('--id', help='custom job id (default: auto-generated)')
    c.add_argument('--label')
    c.add_argument('--workspace', required=True, help='absolute workspace path')
    c.add_argument('--agent', help="agent id (default: 'default')")
    c.add_argument('--prompt', required=True)
    c.add_argument('--schedule', help='5-field cron expression (recurring); mutually exclusive with --run-at')
    c.add_argument('--run-at', dest='run_at',
                   help='one-shot fire time, ISO-8601 (e.g. 2026-05-24T09:00) or unix ms — auto-disables after fire')
    c.add_argument('--timezone', help='IANA tz, e.g. Asia/Shanghai')
    c.add_argument('--timeout-sec', dest='timeout_sec',
                   help='max run time in seconds, 60–21600 (default: unset = 3600)')
    c.add_argument('--session',
                   help="run in this existing root session id (default: the job's own session, same id as the job)")
    c.add_argument('--targets',
                   help='comma-separated channelType:accountId[:chatId] list, or JSON array. '
                        'chatId pins delivery to a specific chat (e.g. when scheduling from inside a chat).')
    c.add_argument('--active-from', dest='active_from',
                   help='recurring only: start firing from this time — YYYY-MM-DD (= that day 00:00), '
                        'ISO-8601 or unix ms; no offset = the job timezone. Use it to "pause until" a date.')
    c.add_argument('--active-until', dest='active_until',
                   help='recurring only: stop firing at this time (exclusive) — YYYY-MM-DD (= the NEXT day 00:00, '
                        'so the date itself still fires), ISO-8601 or unix ms; must be in the future')
    c.add_argument('--disabled', action='store_true', help='create paused (default: enabled)')
    c.set_defaults(func=cmd_create)

    u = sub.add_parser('update')
    u.add_argument('id')
    u.add_argument('--label')
    u.add_argument('--workspace')
    u.add_argument('--agent')
    u.add_argument('--prompt')
    u.add_argument('--schedule')
    u.add_argument('--run-at', dest='run_at')
    u.add_argument('--timezone')
    u.add_argument('--timeout-sec', dest='timeout_sec',
                   help='max run time in seconds, 60–21600; pass "" to clear back to default 3600')
    u.add_argument('--session',
                   help='root session id to run in; pass "" to clear back to the job\'s own session '
                        '(same id as the job — an older job pinned to cron-cron-… then starts a fresh one)')
    u.add_argument('--targets')
    u.add_argument('--active-from', dest='active_from',
                   help='recurring only: YYYY-MM-DD (= that day 00:00), ISO-8601 or unix ms, in the job timezone; '
                        'pass "" to clear (= active now)')
    u.add_argument('--active-until', dest='active_until',
                   help='recurring only: YYYY-MM-DD (= the NEXT day 00:00, date included), ISO-8601 or unix ms, '
                        'in the job timezone; pass "" to clear (= no end)')
    u.set_defaults(func=cmd_update)

    e = sub.add_parser('enable')
    e.add_argument('id')
    e.set_defaults(func=cmd_enable)

    d = sub.add_parser('disable')
    d.add_argument('id')
    d.set_defaults(func=cmd_disable)

    rm = sub.add_parser('delete')
    rm.add_argument('id')
    rm.set_defaults(func=cmd_delete)

    sub.add_parser('channels').set_defaults(func=cmd_channels)

    rs = sub.add_parser('runs')
    rs.add_argument('job_id')
    rs.add_argument('--limit', type=int, default=20)
    rs.add_argument('--before', help='runId cursor; pages older runs')
    rs.set_defaults(func=cmd_runs)

    args = p.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()

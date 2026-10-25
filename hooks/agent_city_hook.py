#!/usr/bin/env python3
"""Agent City hook: forwards a minimal, allowlisted event to the local server.

Run by Claude Code or Codex as a command hook. Stdlib only. It prints nothing
and always exits 0 so it can never block or break the calling tool.
The only value ever read from tool_input is the name of a Skill call
(tool_name == "Skill"), and only when it matches SKILL_NAME; every other
tool_input field, prompt, output and transcript path is dropped.
NEVER probe pids here: os.kill(pid, 0) terminates the process on Windows.
"""
import http.client
import json
import os
import re
import sys

SOURCES = ('claude-code', 'codex')
EVENT_KEYS = ('hook_event_name', 'session_id', 'cwd', 'tool_name', 'agent_id', 'agent_type')
SKILL_NAME = re.compile(r'[A-Za-z0-9_.:@/+-]{1,120}')
MAX_STDIN = 1024 * 1024
TIMEOUT = 0.4


def build_event(data):
    """Keep only allowlisted string fields plus a validated Skill name; prompts and tool payloads never pass."""
    if not isinstance(data, dict):
        return {}
    event = {k: data[k] for k in EVENT_KEYS if isinstance(data.get(k), str)}
    tool_input = data.get('tool_input')
    if data.get('tool_name') == 'Skill' and isinstance(tool_input, dict):
        skill = tool_input.get('skill')
        if isinstance(skill, str) and SKILL_NAME.fullmatch(skill):
            event['skill'] = skill
    return event


def find_registry(env):
    """Return (port, token) from the registry file, or None if absent/invalid."""
    try:
        home = env.get('AGENT_CITY_HOME') or os.path.join(os.path.expanduser('~'), '.agent-city')
        with open(os.path.join(home, 'server.json'), 'rb') as fh:
            reg = json.loads(fh.read(65536).decode('utf-8', errors='replace'))
        port, token = reg.get('protocol') == 1 and reg.get('port'), reg.get('token')
        if (isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535
                and isinstance(token, str) and token):
            return port, token
    except Exception:
        pass
    return None


def post(port, token, source, event):
    """POST the event to the local ingest endpoint; returns the HTTP status."""
    body = json.dumps({'source': source, 'event': event}).encode('utf-8')
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=TIMEOUT)
    try:
        conn.request('POST', '/api/ingest', body=body, headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
        })
        resp = conn.getresponse()
        resp.read()
        return resp.status
    finally:
        conn.close()


def main(argv, stdin_bytes, env=None):
    """Always returns 0; every failure is swallowed."""
    try:
        source = argv[argv.index('--source') + 1] if '--source' in argv else None
        if source not in SOURCES:
            return 0
        data = json.loads(bytes(stdin_bytes or b'')[:MAX_STDIN].decode('utf-8', errors='replace'))
        event = build_event(data)
        reg = find_registry(os.environ if env is None else env)
        if event and reg:
            post(reg[0], reg[1], source, event)
    except BaseException:
        pass
    return 0


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN)
    except BaseException:
        raw = b''
    main(sys.argv[1:], raw)
    sys.exit(0)

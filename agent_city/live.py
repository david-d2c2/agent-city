"""In-memory live activity from Claude Code and Codex hooks; nothing here is persisted."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import threading
import time

SOURCES = ('claude-code', 'codex')
EVENT_KEYS = ('hook_event_name', 'session_id', 'cwd', 'tool_name', 'agent_id', 'agent_type')
SKILL_NAME = re.compile(r'[A-Za-z0-9_.:@/+-]{1,120}')
TTL_TOOL, TTL_WORKING, TTL_WAITING, DROP_AFTER, MAX_ENTRIES = 300, 60, 300, 600, 200
CLAUDE_EVENTS = ('SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Notification')
CODEX_EVENTS = ('PreToolUse', 'PostToolUse', 'Stop')


def normalize_event(source, event):
    """Allowlist and validate one hook payload; prompts and tool inputs never get through.

    The only extra value is `skill`, the validated name of a Skill call: it is kept
    solely on PreToolUse events whose tool is Skill.
    """
    if source not in SOURCES or not isinstance(event, dict):
        raise ValueError('Evento inválido.')
    result = {}
    for key in EVENT_KEYS:
        if key not in event:
            continue
        value = event[key]
        if not isinstance(value, str) or len(value) > (1000 if key == 'cwd' else 300):
            raise ValueError('Campo de evento inválido.')
        result[key] = value
    if not result.get('hook_event_name') or not result.get('session_id'):
        raise ValueError('Faltan campos obligatorios.')
    if 'skill' in event:
        if not isinstance(event['skill'], str) or not SKILL_NAME.fullmatch(event['skill']):
            raise ValueError('Campo de evento inválido.')
        if result['hook_event_name'] == 'PreToolUse' and result.get('tool_name') == 'Skill':
            result['skill'] = event['skill']
    return result


def usage_of(event):
    """Return (kind, name) when a normalized event is a real agent or skill call, else None."""
    if event.get('hook_event_name') == 'SubagentStart' and event.get('agent_type'):
        return 'agent', event['agent_type']
    if event.get('hook_event_name') == 'PreToolUse' and event.get('skill'):
        return 'skill', event['skill']
    return None


def _iso(moment):
    return moment.isoformat()


class LiveState:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.entries = {}
        self.connected = False
        self.last_event = None

    def _entry(self, key, source, session_id, now, agent_id=None):
        entry = self.entries.get(key)
        if entry is None:
            entry = self.entries[key] = {'source': source, 'sessionId': session_id, 'agentId': agent_id, 'agentType': None, 'cwd': '', 'state': 'idle', 'inTool': False, 'tool': None, 'startedAt': now, 'last': now}
            while len(self.entries) > MAX_ENTRIES:
                del self.entries[min(self.entries, key=lambda item: self.entries[item]['last'])]
        return entry

    def _prune(self, now):
        for key in [key for key, entry in self.entries.items() if now - entry['last'] > DROP_AFTER]:
            del self.entries[key]

    def apply(self, source, event):
        name, session_id, agent_id = event['hook_event_name'], event['session_id'], event.get('agent_id')
        with self.lock:
            now = self.clock()
            self.connected = True
            self.last_event = now
            self._prune(now)
            main_key = (source, session_id)
            sub_key = main_key + (agent_id,) if agent_id else None
            if name == 'SessionEnd':
                for key in [key for key in self.entries if key[:2] == main_key]:
                    del self.entries[key]
                return
            if name == 'SubagentStop':
                self.entries.pop(sub_key, None)
                return
            if name not in ('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'Stop', 'Notification', 'PermissionRequest'):
                return
            main = self._entry(main_key, source, session_id, now)
            main['last'] = now
            if event.get('cwd'):
                main['cwd'] = event['cwd']
            if name == 'SessionStart':
                main.update(state='idle', inTool=False, tool=None)
            elif name == 'UserPromptSubmit':
                main.update(state='working', inTool=False)
            elif name in ('PreToolUse', 'PostToolUse'):
                target = main if sub_key is None else self._entry(sub_key, source, session_id, now, agent_id)
                if sub_key is not None:
                    target['last'] = now
                    target['cwd'] = main['cwd']
                    target['agentType'] = event.get('agent_type') or target['agentType']
                if name == 'PreToolUse':
                    target.update(state='working', inTool=True, tool=event.get('tool_name') or None)
                else:
                    target.update(state='working', inTool=False, tool=None)
            elif name == 'SubagentStart' and sub_key is not None:
                sub = self._entry(sub_key, source, session_id, now, agent_id)
                sub.update(state='working', inTool=False, tool=None, last=now, cwd=main['cwd'], agentType=event.get('agent_type') or sub['agentType'])
            elif name == 'Stop':
                main.update(state='idle', inTool=False, tool=None)
                for key in [key for key in self.entries if key[:2] == main_key and len(key) == 3]:
                    del self.entries[key]
            elif name in ('Notification', 'PermissionRequest'):
                main['state'] = 'waiting'

    def snapshot(self):
        with self.lock:
            now = self.clock()
            self._prune(now)
            wall = datetime.now(timezone.utc)
            sessions = []
            for key, entry in sorted(self.entries.items(), key=lambda item: item[1]['startedAt']):
                age = now - entry['last']
                ttl = TTL_WAITING if entry['state'] == 'waiting' else TTL_TOOL if entry['inTool'] else TTL_WORKING
                sessions.append({
                    'key': '|'.join(key),
                    'source': entry['source'],
                    'sessionId': entry['sessionId'],
                    'agentType': entry['agentType'],
                    'parentKey': '|'.join(key[:2]) if len(key) == 3 else None,
                    'cwd': entry['cwd'],
                    'state': entry['state'],
                    'active': entry['state'] in ('working', 'waiting') and age < ttl,
                    'tool': entry['tool'],
                    'startedAt': _iso(wall - timedelta(seconds=now - entry['startedAt'])),
                    'lastEventAt': _iso(wall - timedelta(seconds=age)),
                    'ageSeconds': int(age),
                })
            last = None if self.last_event is None else _iso(wall - timedelta(seconds=now - self.last_event))
            return {'connected': self.connected, 'lastEventAt': last, 'sessions': sessions}


def registry_dir():
    return Path(os.environ.get('AGENT_CITY_HOME') or Path.home() / '.agent-city')


def registry_file():
    return registry_dir() / 'server.json'


def write_registry(port, token):
    """Publish port and token atomically so hook scripts can find this server."""
    directory = registry_dir()
    directory.mkdir(parents=True, exist_ok=True)
    target = registry_file()
    temp = target.with_name('server.json.' + str(os.getpid()) + '.tmp')
    temp.write_text(json.dumps({'protocol': 1, 'port': port, 'pid': os.getpid(), 'token': token, 'startedAt': int(time.time())}), encoding='utf-8')
    os.replace(temp, target)
    return target


def remove_registry(token):
    """Remove the registry only when it still holds this server's token."""
    try:
        target = registry_file()
        if json.loads(target.read_text(encoding='utf-8')).get('token') == token:
            target.unlink()
    except (OSError, ValueError, AttributeError):
        pass


def connect_info(hook_script, python, registry):
    script, interpreter = str(hook_script).replace('\\', '/'), str(python).replace('\\', '/')

    def snippet(source, events):
        command = '[ ! -f "' + script + '" ] || "' + interpreter + '" "' + script + '" --source ' + source + ' || true'
        group = [{'matcher': '', 'hooks': [{'type': 'command', 'command': command, 'timeout': 2}]}]
        return json.dumps({'hooks': {event: group for event in events}}, indent=2)

    return {
        'registry': str(registry),
        'hookScript': str(hook_script),
        'python': str(python),
        'claudeCode': {'file': '~/.claude/settings.json', 'snippet': snippet('claude-code', CLAUDE_EVENTS)},
        'codex': {'file': '~/.codex/hooks.json', 'snippet': snippet('codex', CODEX_EVENTS)},
    }

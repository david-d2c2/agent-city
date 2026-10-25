"""One-off, opt-in import of past agent and skill usage from Claude Code transcripts.

Privacy contract: transcripts are streamed line by line and only lines that contain a
literal tool-call marker are parsed. From those, only the skill name or subagent type of
a tool call and the line timestamp are read; the opaque tool-call id is kept in memory
for the run only, to drop calls repeated by resumed sessions. The line's working folder is
read only to look up the registered project id it belongs to; the folder itself is never
stored. Nothing else is read, stored, logged or put in an error message.
"""
from datetime import datetime
from functools import lru_cache
import json
import os
from pathlib import Path
import stat
import time

from .live import SKILL_NAME
from .store import usage_name

MARKERS = (b'"name":"Skill"', b'"name":"Task"', b'"name":"Agent"')
MAX_LINE_BYTES = 4 * 1024 * 1024
MAX_KEYS, MAX_IDS, CLOCK_EVERY = 100000, 1000000, 20000
MISSING = 'No se encontró el historial de Claude Code.'


def _linked(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def _transcripts(root):
    """Yield (path, size) for every regular .jsonl below root without following links or junctions."""
    pending = [root]
    while pending:
        try:
            with os.scandir(pending.pop()) as entries:
                for entry in sorted(entries, key=lambda item: item.name):
                    try:
                        info = entry.stat(follow_symlinks=False)
                        if _linked(info):
                            continue
                        if stat.S_ISDIR(info.st_mode):
                            pending.append(entry.path)
                        elif stat.S_ISREG(info.st_mode) and entry.name.endswith('.jsonl'):
                            yield entry.path, info.st_size
                    except OSError:
                        continue
        except OSError:
            continue


def _local_day(stamp):
    if not isinstance(stamp, str) or len(stamp) > 40:
        return None
    try:
        return datetime.fromisoformat(stamp.replace('Z', '+00:00')).astimezone().date().isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def _calls(entry):
    """Yield (kind, name, call id) for each Skill/Task/Agent tool call of one parsed transcript line."""
    message = entry.get('message') if isinstance(entry, dict) else None
    blocks = message.get('content') if isinstance(message, dict) else None
    for block in blocks if isinstance(blocks, list) else ():
        if not isinstance(block, dict) or block.get('type') != 'tool_use' or not isinstance(block.get('input'), dict):
            continue
        if block.get('name') == 'Skill':
            skill = block['input'].get('skill')
            if isinstance(skill, str) and SKILL_NAME.fullmatch(skill):
                yield 'skill', skill, block.get('id')
        elif block.get('name') in ('Task', 'Agent'):
            agent = usage_name(block['input'].get('subagent_type'))
            if agent:
                yield 'agent', agent, block.get('id')


def _read(path, counts, seen, deadline, resolve):
    """Stream one transcript into counts; returns False when the time budget ran out."""
    with open(path, 'rb') as handle:
        for number, line in enumerate(handle):
            if number % CLOCK_EVERY == 0 and time.monotonic() > deadline:
                return False
            if len(line) > MAX_LINE_BYTES or not any(marker in line for marker in MARKERS):
                continue
            try:
                entry = json.loads(line)
            except (ValueError, RecursionError):
                continue
            day = _local_day(entry.get('timestamp')) if isinstance(entry, dict) else None
            cwd = entry.get('cwd') if day else None
            project = resolve(cwd) if isinstance(cwd, str) and len(cwd) <= 1000 else ''
            for kind, name, call_id in _calls(entry) if day else ():
                if isinstance(call_id, str) and call_id:
                    if call_id in seen:
                        continue
                    if len(seen) < MAX_IDS:
                        seen.add(call_id)
                key = (day, kind, name, project)
                if key in counts or len(counts) < MAX_KEYS:
                    counts[key] = counts.get(key, 0) + 1
    return True


def import_claude_history(store, projects_dir=None, now=None, max_files=5000, max_file_bytes=64 * 1024 * 1024, budget_seconds=60):
    """Replace the stored history with the usage found in Claude Code transcripts; returns the imported summary."""
    root = Path(projects_dir) if projects_dir is not None else Path.home() / '.claude' / 'projects'
    if not root.is_dir():
        raise ValueError(MISSING)
    now = now or datetime.now()
    deadline = time.monotonic() + budget_seconds
    counts, seen, files, skipped, partial = {}, set(), 0, 0, False
    resolve = lru_cache(maxsize=4096)(store.project_for_cwd)
    for path, size in _transcripts(root):
        if files + skipped >= max_files or time.monotonic() > deadline:
            partial = True
            break
        if size > max_file_bytes:
            skipped += 1
            continue
        try:
            complete = _read(path, counts, seen, deadline, resolve)
        except OSError:
            skipped += 1
            continue
        files += 1
        if not complete:
            partial = True
            break
    imported = store.replace_usage_history(counts, files, skipped, today=now.date().isoformat(), imported_at=now.astimezone().isoformat())
    imported['partial'] = partial
    return imported

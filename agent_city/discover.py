"""Folder discovery from names only: suggested sources and project folders.

Counts mirror catalog.scan (same depth, entry and definition limits, links and
excluded folders skipped) but never open or read a file, so discovery stays cheap.
"""
import itertools
import os
from pathlib import Path

from .catalog import EXCLUDED_DIRECTORIES, MAX_DEFINITIONS, MAX_ENTRIES, approved_path, eligible

MAX_PROJECT_FOLDERS = 300
# (label, folder under the home directory, format). The first three keep their historical labels.
KNOWN = [
    ('Agentes locales', '.codex/agents', 'roles'),
    ('Skills locales', '.agents/skills', 'skills'),
    ('Agentes de Claude Code', '.claude/agents', 'claude-agents'),
    ('Skills de Claude Code', '.claude/skills', 'skills'),
    ('Skills de Codex', '.codex/skills', 'skills'),
    ('Skills de Hermes', '.hermes/skills', 'skills'),
    ('Skills de ZCode', '.zcode/skills', 'skills'),
    ('Skills de Gemini', '.gemini/skills', 'skills'),
    # Note: ~/.openclaw itself holds 80k+ entries (npm, logs); only its skill folders are worth scanning.
    ('Skills de OpenClaw', '.openclaw/skills', 'skills'),
    ('Skills de plugins de OpenClaw', '.openclaw/plugin-skills', 'skills'),
]
PLUGIN_PARTS = (('agents', 'claude-agents', 'agentes'), ('skills', 'skills', 'skills'))


def linked(entry):
    try:
        return entry.is_symlink() or bool(getattr(entry.stat(follow_symlinks=False), 'st_file_attributes', 0) & 0x400)
    except OSError:
        return True


def count_definitions(root, format):
    pending, visited, found = [(root, 0)], 0, 0
    while pending:
        directory, depth = pending.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > MAX_ENTRIES:
                        return found
                    if linked(entry):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if depth < 8 and entry.name.casefold() not in EXCLUDED_DIRECTORIES:
                            pending.append((entry.path, depth + 1))
                    elif eligible(entry.name, format):
                        found += 1
                        if found >= MAX_DEFINITIONS:
                            return found
        except OSError:
            continue
    return found


def subdirectories(path):
    try:
        with os.scandir(path) as entries:
            return [(entry.path, entry.name, entry.stat(follow_symlinks=False).st_mtime) for entry in itertools.islice(entries, MAX_ENTRIES) if not linked(entry) and entry.is_dir(follow_symlinks=False)]
    except OSError:
        return []


def plugin_candidates(home):
    """cache/<marketplace>/<plugin>/<version>/{agents,skills}: only each plugin's newest version (by modification time)."""
    cache = home / '.claude' / 'plugins' / 'cache'
    for market_path, _, _ in sorted(subdirectories(cache), key=lambda row: row[1].casefold()):
        for plugin_path, plugin, _ in sorted(subdirectories(market_path), key=lambda row: row[1].casefold()):
            versions = sorted(subdirectories(plugin_path), key=lambda row: row[2], reverse=True)
            if versions:
                for part, format, noun in PLUGIN_PARTS:
                    yield 'Plugin ' + plugin[:120] + ' · ' + noun, Path(versions[0][0]) / part, format


def discover_roots(home=None):
    """Suggested sources that exist and would import at least one definition: [{label, path, format, count}]."""
    home = Path(home) if home is not None else Path.home()
    candidates = [(label, home / relative, format) for label, relative, format in KNOWN]
    found = []
    for label, path, format in itertools.chain(candidates, plugin_candidates(home)):
        try:
            approved_path(str(path))
        except (OSError, ValueError):
            continue
        count = count_definitions(path, format)
        if count:
            found.append({'label': label, 'path': str(path), 'format': format, 'count': count})
    return found


def list_folders(path):
    """First-level, visible, non-link subfolders of a folder: ({name, path} rows, truncated)."""
    parent = approved_path(path)
    rows = []
    try:
        with os.scandir(parent) as entries:
            for entry in itertools.islice(entries, MAX_ENTRIES):
                name = entry.name
                child = str(parent / name)
                # Names that a project could not hold (control characters, over-long paths) are not offered.
                if name.startswith('.') or name.casefold() == 'node_modules' or len(child) > 1000 or any(ord(char) < 32 or ord(char) == 127 for char in child):
                    continue
                if not linked(entry) and entry.is_dir(follow_symlinks=False):
                    rows.append({'name': name, 'path': child})
    except OSError:
        raise ValueError('No se pudo leer la carpeta.')
    rows.sort(key=lambda row: row['name'].casefold())
    return rows[:MAX_PROJECT_FOLDERS], len(rows) > MAX_PROJECT_FOLDERS

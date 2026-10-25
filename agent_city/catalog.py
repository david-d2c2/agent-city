"""Bounded metadata import. No document execution or reference following.

Discovery is explicit by root and format, at most eight nested directories,
2,000 definitions and 20,000 directory entries. Frontmatter supports flat strings,
quoted strings, and indented |/> blocks only. Unknown fields are omitted.
Deep metadata (skill allowed-tools, invocation flags, version, license, sibling
file names; role instruction length; Claude agent tools and model) is bounded,
header-only and never makes an item invalid. The claude-agents format reads
flat *.md files (except README.md) through the same header-only path as skills.
"""
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import stat
import tomllib

MAX_BYTES = 65536
MAX_DEFINITIONS = 2000
MAX_ENTRIES = 20000
MAX_TOOLS = 100
MAX_FILES = 50
MAX_NAME = 120
DEEP_KEYS = ('allowed-tools', 'user-invocable', 'disable-model-invocation', 'version', 'license')
AGENT_KEYS = ('tools', 'model')
FIELDS = ('name', 'description', 'specialty')
# Explicit bidi and zero-width controls can visually spoof a name (U+202E reverses everything after it).
BIDI_CONTROLS = frozenset('​‌‍‎‏‪‫‬‭‮⁦⁧⁨⁩﻿')
EXCLUDED_DIRECTORIES = {'.git', '.svn', 'node_modules', '__pycache__', '.venv', 'venv', '.local', 'data', 'logs', 'sessions', 'backups'}
EXCLUDED_FILES = {'credentials.toml', 'secrets.toml', 'auth.toml', 'session.toml', 'config.toml'}


def normalized(path):
    return os.path.normcase(str(path)).replace('\\', '/')


def linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def approved_path(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError('Ruta de fuente inválida.')
    path = Path(os.path.abspath(value))
    # Network (UNC) and device paths would make this process authenticate to a remote host: sources are local folders.
    if str(path).startswith(('\\\\', '//')) or os.path.splitdrive(str(path))[0].startswith(('\\\\', '//')):
        raise ValueError('Ruta de fuente inválida.')
    try:
        for part in (path, *path.parents):
            if linked(part):
                raise ValueError('No se permiten enlaces ni uniones en las fuentes.')
        if not path.is_dir():
            raise ValueError('La fuente debe ser una carpeta existente.')
        return path.resolve()
    except OSError:
        raise ValueError('La fuente debe ser una carpeta existente.')


def clean_string(value, required=False, limit=4000):
    if value is None and not required:
        return ''
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError('Metadato de texto no compatible o demasiado largo.')
    value = ''.join(c for c in value if (c in '\n\t' or ord(c) >= 32) and c not in BIDI_CONTROLS).strip()
    if required and not value:
        raise ValueError('Falta un nombre válido en los metadatos.')
    return value


def scalar(text):
    text = text.strip()
    if not text or text.startswith(('[', '{', '&', '*', '!', '|', '>')):
        raise ValueError('Formato de metadatos no compatible.')
    if text.startswith('"'):
        value = json.loads(text)
        if not isinstance(value, str):
            raise ValueError('Se requiere texto.')
        return value
    if text.startswith("'"):
        if len(text) < 2 or not text.endswith("'"):
            raise ValueError('Texto entre comillas incompleto.')
        return text[1:-1].replace("''", "'")
    return text


def skill_metadata(text):
    lines = text.splitlines()
    if not lines or lines[0].lstrip('\ufeff').strip() != '---':
        raise ValueError('SKILL.md necesita cabecera de metadatos delimitada por ---.')
    data = {}
    index = 1
    while index < len(lines):
        line = lines[index]
        index += 1
        if line.strip() == '---':
            return data
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z][\w-]*):\s*(.*)', line)
        if not match:
            # Ignore nested unsupported fields, but never guess known fields.
            if line.startswith((' ', '\t')):
                continue
            raise ValueError('Cabecera plana no compatible.')
        key, value = match.groups()
        if key not in FIELDS:
            continue
        if key in data:
            raise ValueError('Metadato repetido.')
        if value in ('|', '>', '|-', '>-', '|+', '>+'):
            block = []
            while index < len(lines) and (not lines[index].strip() or lines[index].startswith(' ')):
                block.append(lines[index])
                index += 1
            nonempty = [len(row) - len(row.lstrip(' ')) for row in block if row.strip()]
            indent = min(nonempty, default=0)
            data[key] = (' ' if value.startswith('>') else '\n').join(row[indent:] for row in block)
        else:
            data[key] = scalar(value)
    raise ValueError('La cabecera no termina dentro del límite de lectura.')


def tool_list(value, block):
    if not value:
        items = []
        for row in block:
            # No regular expression here: a long run of spaces made the old pattern quadratic and froze the server.
            stripped = row.strip()
            if len(row) > 1024 or not row[:1].isspace() or not stripped.startswith('-') or not stripped[1:2].isspace():
                raise ValueError('Lista de herramientas no compatible.')
            items.append(scalar(stripped[1:].strip()))
    elif value.startswith('['):
        if not value.endswith(']'):
            raise ValueError('Lista de herramientas incompleta.')
        inner = value[1:-1].strip()
        items = [scalar(part) for part in inner.split(',') if part.strip()]
    else:
        text = scalar(value)
        items = re.findall(r'[^,\s()]+(?:\([^)]*\))?', text)
    items = [item.strip() for item in items]
    return [item for item in items if item and len(item) <= MAX_NAME and '\n' not in item][:MAX_TOOLS]


def flag(value):
    text = scalar(value).strip().lower()
    return text == 'true' if text in ('true', 'false') else None


def short_text(value):
    try:
        return clean_string(scalar(value), limit=200)
    except ValueError:
        return ''


def deep_fields(text, keys, block_key):
    """Return a parser over the declared deep keys of a frontmatter header; each field fails alone."""
    found = {}
    lines = text.splitlines()
    index = 1
    while index < len(lines) and lines[index].strip() != '---':
        line = lines[index]
        index += 1
        match = re.fullmatch(r'([A-Za-z][\w-]*):[ 	]*(.*)', line)
        if not match or match.group(1) not in keys or match.group(1) in found:
            continue
        key, value = match.group(1), match.group(2).strip()
        block = []
        while key == block_key and not value and index < len(lines) and (not lines[index].strip() or lines[index].startswith((' ', '	'))):
            if lines[index].strip():
                block.append(lines[index])
            index += 1
        found[key] = (value, block)
    def parse(key, convert, default):
        if key not in found:
            return default
        try:
            return convert(*found[key])
        except (ValueError, TypeError):
            return default
    return parse


def skill_deep(text):
    parse = deep_fields(text, DEEP_KEYS, 'allowed-tools')
    disabled = parse('disable-model-invocation', lambda value, block: flag(value), None)
    return {
        'allowedTools': parse('allowed-tools', tool_list, None),
        'userInvocable': parse('user-invocable', lambda value, block: flag(value), None),
        'modelInvocable': None if disabled is None else not disabled,
        'version': parse('version', lambda value, block: short_text(value), ''),
        'license': parse('license', lambda value, block: short_text(value), ''),
    }


def agent_deep(text):
    parse = deep_fields(text, AGENT_KEYS, 'tools')
    return {
        'allowedTools': parse('tools', tool_list, None),
        'model': parse('model', lambda value, block: clean_string(scalar(value), limit=100), ''),
    }


def sibling_files(directory):
    """Names only of direct entries, never following links or reading content."""
    names = []
    try:
        with os.scandir(directory) as entries:
            for entry in itertools.islice(entries, MAX_ENTRIES):
                if entry.name == 'SKILL.md' or len(entry.name) > MAX_NAME:
                    continue
                try:
                    if linked(Path(entry.path)):
                        continue
                    names.append({'name': entry.name, 'kind': 'dir' if entry.is_dir(follow_symlinks=False) else 'file'})
                except OSError:
                    continue
    except OSError:
        return [], False
    names.sort(key=lambda row: row['name'])
    return names[:MAX_FILES], len(names) > MAX_FILES


def read_metadata(path, root, format):
    # Recheck each ancestor immediately before the read and reject nonregular files.
    for part in (path, *path.parents):
        if linked(part):
            raise ValueError('Enlace excluido de la lectura.')
        if part == root:
            break
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError('Archivo fuera de la fuente aprobada.')
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or (format == 'roles' and before.st_size > MAX_BYTES):
        raise ValueError('Archivo no regular o demasiado grande.')
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('La fuente cambió durante la lectura.')
        if format == 'roles':
            raw = stream.read(MAX_BYTES + 1)
        else:
            # Read only the header, never the Markdown instruction body.
            chunks, size, delimiters = [], 0, 0
            while size <= MAX_BYTES:
                line = stream.readline(min(MAX_BYTES + 1 - size, 8192))
                if not line:
                    break
                chunks.append(line)
                size += len(line)
                if line.decode('utf-8-sig').strip() == '---':
                    delimiters += 1
                    if delimiters == 2:
                        break
            raw = b''.join(chunks)
        if len(raw) > MAX_BYTES:
            raise ValueError('Metadatos demasiado grandes.')
    if linked(path) or path.resolve() != resolved:
        raise ValueError('La fuente cambió durante la lectura.')
    text = raw.decode('utf-8-sig')
    data = tomllib.loads(text) if format == 'roles' else skill_metadata(text)
    # Role wrappers are explicitly supported in addition to flat TOML.
    if isinstance(data.get('agent'), dict):
        data = data['agent']
    metadata = {key: clean_string(data.get(key), required=key == 'name', limit=200 if key in ('name', 'specialty') else 4000) for key in FIELDS}
    digest = hashlib.sha256(json.dumps(metadata, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    if format == 'roles':
        instructions = data.get('developer_instructions')
        details = {'instructionChars': len(instructions) if isinstance(instructions, str) else 0}
    elif format == 'claude-agents':
        details = agent_deep(text)
    else:
        details = skill_deep(text)
        details['files'], details['filesTruncated'] = sibling_files(path.parent)
    return metadata, digest, details


def eligible(name, format):
    """Whether a file name is a definition for this root format (shared with source discovery)."""
    if name.casefold() in EXCLUDED_FILES:
        return False
    if format == 'roles':
        return os.path.splitext(name)[1].lower() == '.toml'
    if format == 'claude-agents':
        return os.path.splitext(name)[1].lower() == '.md' and name.casefold() != 'readme.md'
    return name == 'SKILL.md'


def scan(root_record):
    root = Path(root_record['path'])
    result = {'items': [], 'diagnostics': [], 'complete': True, 'failed': False}
    try:
        approved_path(str(root))
    except (OSError, ValueError):
        result.update(complete=False, failed=True, diagnostics=['No se pudo acceder a la fuente aprobada.'])
        return result
    pending, visited, definitions = [(root, 0)], 0, 0
    while pending:
        directory, depth = pending.pop()
        try:
            if linked(directory) or not directory.resolve().is_relative_to(root):
                raise ValueError('Enlace excluido.')
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > MAX_ENTRIES:
                        result['complete'] = False
                        result['diagnostics'].append('Se alcanzó el límite de 20000 entradas.')
                        return result
                    path = Path(entry.path)
                    relative = path.relative_to(root).as_posix()
                    if linked(path):
                        result['complete'] = False
                        result['diagnostics'].append('Enlace excluido: ' + relative)
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if path.name.casefold() in EXCLUDED_DIRECTORIES:
                            continue
                        if depth >= 8:
                            result['complete'] = False
                            result['diagnostics'].append('Se alcanzó la profundidad máxima de 8 carpetas.')
                        else:
                            pending.append((path, depth + 1))
                        continue
                    if not eligible(path.name, root_record['format']):
                        continue
                    definitions += 1
                    if definitions > MAX_DEFINITIONS:
                        result['complete'] = False
                        result['diagnostics'].append('Se alcanzó el límite de 2000 definiciones.')
                        return result
                    identity = root_record['id'] + ':' + normalized(relative)
                    item = {'id': hashlib.sha256(identity.encode()).hexdigest()[:32], 'kind': 'skill' if root_record['format'] == 'skills' else 'role', 'source': {'rootId': root_record['id'], 'relativePath': relative, 'format': root_record['format']}}
                    try:
                        metadata, digest, details = read_metadata(path, root, root_record['format'])
                        item.update(metadata, digest=digest, validity='valid', diagnostics=[], details=details)
                    except (OSError, ValueError, UnicodeError, tomllib.TOMLDecodeError, RecursionError, MemoryError):
                        item.update(name='', description='', specialty='', digest='', details={}, validity='invalid', diagnostics=['Metadatos inválidos o no compatibles; revisa nombre, cabecera y límites.'])
                    result['items'].append(item)
        except (OSError, ValueError):
            result['complete'] = False
            result['diagnostics'].append('No se pudo completar una carpeta de la fuente.')
    return result

"""Read the project .env the same way the Node side (dotenv) does.

Trailing comments must not become part of a value: `BRAVE_SEARCH_API_KEY=   # optional` is an empty key,
not the text "# optional" (which would make a source look configured and send nonsense as a credential)."""
import os
import re
from pathlib import Path


def parse_line(line):
    """Return (key, value) for a KEY=value line, or None for blanks, comments and anything else."""
    line = line.strip()
    if not line or line.startswith('#'):
        return None
    line = re.sub(r'^export\s+', '', line)
    key, sep, rest = line.partition('=')
    key = key.strip()
    if not sep or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]*', key):
        return None
    rest = rest.strip()
    if rest[:1] in ('"', "'"):
        end = rest.find(rest[0], 1)
        if end != -1:
            return key, rest[1:end]
    if rest.startswith('#'):
        return key, ''
    return key, re.split(r'\s+#', rest, maxsplit=1)[0].strip()


def parse(text):
    return dict(pair for pair in map(parse_line, text.splitlines()) if pair)


def load_env(path):
    """Set variables from a .env file without overriding real environment variables."""
    path = Path(path)
    if path.exists():
        for key, value in parse(path.read_text(encoding='utf-8')).items():
            os.environ.setdefault(key, value)

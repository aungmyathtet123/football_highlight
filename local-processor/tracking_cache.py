"""Versioned local observations and scene checkpoints, independent of narration."""
import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path


def fingerprint(path):
    path = Path(path).resolve()
    info = path.stat()
    return [str(path), info.st_size, info.st_mtime_ns]


def content_fingerprint(path):
    """Stable identity for identical uploads stored under different job paths."""
    path = Path(path).resolve()
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            hasher.update(chunk)
    return [path.stat().st_size, hasher.hexdigest()]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


class ObservationStore:
    def __init__(self, path, signature):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        # Several locked scenes are tracked in parallel and intentionally share
        # this cache.  SQLite's connect timeout does not protect PRAGMA/schema
        # initialization, so two fresh workers could race here and abort an
        # otherwise healthy job with ``database is locked``.
        self.db = sqlite3.connect(path, timeout=120)
        self.db.execute("PRAGMA busy_timeout=120000")
        self._with_lock_retry(lambda: self.db.execute("PRAGMA journal_mode=WAL"))
        self._with_lock_retry(lambda: self.db.execute(
            "CREATE TABLE IF NOT EXISTS observations (signature TEXT, frame INTEGER, payload TEXT, PRIMARY KEY(signature, frame))"
        ))
        self.signature = digest(signature)
        self.hits = self.misses = 0

    def _with_lock_retry(self, operation):
        delay = 0.05
        deadline = time.monotonic() + 120
        while True:
            try:
                return operation()
            except sqlite3.OperationalError as error:
                if not any(token in str(error).lower() for token in ("locked", "busy")) or time.monotonic() >= deadline:
                    raise
                time.sleep(delay)
                delay = min(delay * 1.7, 1.5)

    def get(self, frame):
        row = self._with_lock_retry(lambda: self.db.execute(
            "SELECT payload FROM observations WHERE signature=? AND frame=?", (self.signature, frame)
        ).fetchone())
        if row is None:
            self.misses += 1
            return None
        self.hits += 1
        return json.loads(row[0])

    def put(self, frame, value):
        def persist():
            try:
                self.db.execute("INSERT OR REPLACE INTO observations VALUES (?, ?, ?)", (self.signature, frame, json.dumps(value)))
                # Persist each expensive observation so interrupted runs retain progress.
                self.db.commit()
            except sqlite3.OperationalError:
                self.db.rollback()
                raise

        self._with_lock_retry(persist)

    def close(self):
        self.db.close()


def scene_key(moment, signature):
    # Text, colors, and caption settings cannot invalidate source tracking.
    fields = ("startTime", "endTime", "eventType", "storyPhase", "role", "focusX", "trackingBrief")
    return digest([signature, {key: moment.get(key) for key in fields}])

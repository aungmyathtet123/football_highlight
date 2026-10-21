"""Decode recovery and cache readiness; no fabricated tracking observations."""
import math
import os
import subprocess
import tempfile
from pathlib import Path


def usable_tracking_checkpoint(result):
    return (isinstance(result, dict)
            and int(result.get("sampledFrames", 0) or 0) > 0
            and bool(result.get("sourceRecords")))


def normalize_tracking_source(source, fps, directory):
    """A disposable CFR decode proxy; timestamps remain in source seconds."""
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("Tracking decoder returned invalid frame rate")
    descriptor, name = tempfile.mkstemp(prefix="decode-repair-", suffix=".mp4", dir=directory)
    os.close(descriptor)
    target = Path(name)
    try:
        subprocess.run([
            os.environ.get("FFMPEG_PATH", "ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-map", "0:v:0", "-an", "-vf", f"fps={fps:.10f},setpts=PTS-STARTPTS",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-threads", "2",
            "-pix_fmt", "yuv420p", str(target),
        ], check=True, timeout=600, capture_output=True)
        return target
    except Exception:
        target.unlink(missing_ok=True)
        raise

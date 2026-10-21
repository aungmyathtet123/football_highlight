"""Small spatial proxy for cut detection; preserve source frame rate/timing."""
import math


SHOT_BOUNDARY_VERSION = 4


def serialized_shot_fingerprint(source_fingerprint):
    # JSON numbers lose nanosecond precision in JavaScript. Keep the exact
    # integer as text so a saved cut ledger is not recomputed on every read.
    return [source_fingerprint[0], str(source_fingerprint[1]), str(source_fingerprint[2])]


def shot_proxy_args(source, destination):
    return [
        "-hide_banner", "-loglevel", "error", "-y", "-threads", "2", "-i", str(source),
        "-map", "0:v:0", "-an", "-vf", "scale=w='min(480,iw)':h=-2,setsar=1",
        "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "ultrafast",
        "-crf", "12", "-threads", "2", "-pix_fmt", "yuv420p", str(destination),
    ]


def validate_shot_proxy_timing(source_duration, proxy_duration, source_fps, proxy_fps):
    values = [source_duration, proxy_duration, source_fps, proxy_fps]
    if not all(math.isfinite(value) and value > 0 for value in values):
        raise ValueError("Cut-analysis proxy has invalid timing metadata")
    if abs(source_fps - proxy_fps) > max(.001, source_fps * .0001):
        raise ValueError("Cut-analysis proxy changed the source frame rate")
    if abs(source_duration - proxy_duration) > max(.1, 2 / source_fps):
        raise ValueError("Cut-analysis proxy changed or truncated source duration")

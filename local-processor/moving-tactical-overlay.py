"""Frame-tracked tactical network for a verified live pass buildup.

The overlay contains only observed player feet. It ends at the verified pass
freeze, resets at a broadcast cut, and fails closed when identities drift.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import cv2
import numpy as np


overlay_spec = importlib.util.spec_from_file_location(
    "tactical_overlay", Path(__file__).with_name("tactical-overlay.py"))
overlay = importlib.util.module_from_spec(overlay_spec)
overlay_spec.loader.exec_module(overlay)


# Keep the live connector consistent with the freeze drawing: red means the
# observed ball-carrier-to-receiver relationship, not an invented player.
WHITE = (45, 55, 245, 242)
SHADOW = (0, 0, 0, 125)


def player_by_id(record, identity):
    return next((player for player in record.get("players", [])
                 if player.get("trackId") == identity and player.get("confidence", 0) >= .30
                 and player.get("trackAge", 2) >= 2), None)


def crop_at(keyframes, time, native_landscape):
    if native_landscape:
        return [0, 0, 1, 1]
    return min(keyframes, key=lambda frame: abs(frame["time"] - time))["cropBox"]


def project(point, crop, width, height):
    x = (point[0] - crop[0]) / max(1e-6, crop[2] - crop[0])
    y = (point[1] - crop[1]) / max(1e-6, crop[3] - crop[1])
    if not (.03 < x < .97 and .06 < y < .95):
        return None
    return np.array([x * width, y * height], dtype=float)


def smooth_series(values, radius=2):
    result = []
    for index in range(len(values)):
        start, end = max(0, index-radius), min(len(values), index+radius+1)
        result.append(np.median(np.asarray(values[start:end]), axis=0))
    return result


def draw_ring(canvas, point, stroke):
    xy = tuple(np.rint(point).astype(int))
    axes = (max(16, stroke*4), max(6, stroke+2))
    cv2.ellipse(canvas, xy, axes, 0, 0, 360, SHADOW, stroke+3, cv2.LINE_AA)
    cv2.ellipse(canvas, xy, axes, 0, 0, 360, WHITE, stroke, cv2.LINE_AA)


def render_motion(evidence, requested_source_time, output_dir, width=1920, height=1080,
                  native_landscape=False):
    records = evidence.get("sourceRecords", [])
    keyframes = evidence.get("keyframes", [])
    if not records or not keyframes:
        return {"approved": False, "reason": "missing_tracking"}
    requested = requested_source_time - evidence["sourceStartTime"]
    # Evaluate nearby verified handoffs and retain only one with a sustained
    # pre-pass identity run. The nearest detection alone might be too early;
    # the latest plausible pass might belong to a different pair of players.
    candidates = [(record, overlay.drawing_points(records, record, "pass")) for record in records
                  if abs(record["time"] - requested) <= 2.0]
    candidates = [(record, points) for record, points in candidates if points]
    candidates.sort(key=lambda item: (abs(item[0]["time"] - requested), item[0]["time"]))
    if not candidates:
        return {"approved": False, "reason": "no_verified_pass_handoff"}
    chosen = None
    for candidate, _ in candidates:
        carrier, receiver, _ = overlay.verified_pass_players(records, candidate)
        if carrier is None or receiver is None:
            continue
        carrier_id, receiver_id = carrier.get("trackId"), receiver.get("trackId")
        usable = []
        for record in records:
            if not candidate["time"] - 1.35 <= record["time"] <= candidate["time"]:
                continue
            if record.get("scene_cut"):
                usable = []
                continue
            first, second = player_by_id(record, carrier_id), player_by_id(record, receiver_id)
            if first is None or second is None:
                continue
            crop = crop_at(keyframes, record["time"], native_landscape)
            a = project([first["cx"], first["y2"]], crop, width, height)
            b = project([second["cx"], second["y2"]], crop, width, height)
            if a is None or b is None or np.linalg.norm(a-b) < width*.045:
                continue
            usable.append((record["time"], a, b))
        if len(usable) < 6 or usable[-1][0] - usable[0][0] < .36:
            continue
        run = [usable[-1]]
        for item in reversed(usable[:-1]):
            if run[0][0] - item[0] > .24:
                break
            run.insert(0, item)
        if len(run) >= 6 and run[-1][0] - run[0][0] >= .36:
            chosen = (candidate, carrier_id, receiver_id, run)
            break
    if chosen is None:
        return {"approved": False, "reason": "live_identity_run_not_contiguous"}
    anchor, carrier_id, receiver_id, run = chosen
    start, end = run[0][0], run[-1][0]
    frame_count = max(2, int(round((end-start)*30))+1)
    times = np.linspace(start, end, frame_count)
    observed_times = np.asarray([item[0] for item in run])
    first = [np.array([np.interp(t, observed_times, [item[1][axis] for item in run]) for axis in (0,1)]) for t in times]
    second = [np.array([np.interp(t, observed_times, [item[2][axis] for item in run]) for axis in (0,1)]) for t in times]
    first, second = smooth_series(first), smooth_series(second)
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    stroke = max(3, int(round(max(width, height)/480)))
    for index, (a, b) in enumerate(zip(first, second)):
        canvas = np.zeros((height, width, 4), np.uint8)
        start_xy, end_xy = tuple(np.rint(a).astype(int)), tuple(np.rint(b).astype(int))
        cv2.line(canvas, start_xy, end_xy, SHADOW, stroke+4, cv2.LINE_AA)
        cv2.line(canvas, start_xy, end_xy, WHITE, stroke, cv2.LINE_AA)
        draw_ring(canvas, a, stroke)
        draw_ring(canvas, b, stroke)
        cv2.imwrite(str(directory / f"{index:05d}.png"), canvas)
    absolute_start = evidence["sourceStartTime"] + start
    return {
        "approved": True,
        "kind": "moving_pass_network",
        "sourceStartTime": absolute_start,
        "sourceEndTime": evidence["sourceStartTime"] + end,
        "duration": end-start,
        "frameCount": frame_count,
        "carrierTrackId": carrier_id,
        "receiverTrackId": receiver_id,
        "anchorSourceTime": evidence["sourceStartTime"] + anchor["time"],
        "pattern": str((directory / "%05d.png").resolve()),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--time", type=float, required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--native-landscape", action="store_true")
    args = parser.parse_args()
    result = render_motion(json.loads(Path(args.evidence).read_text()), args.time, args.output_dir,
                           args.width, args.height, args.native_landscape)
    print(json.dumps(result))

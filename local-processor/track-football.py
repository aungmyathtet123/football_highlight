import argparse
import json
import math
import os
import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO


PERSON_CLASS = 0
SPORTS_BALL_CLASS = 32
MAX_BALL_GAP_SECONDS = 1.0
MAX_PLAYER_GAP_SECONDS = 0.55
MARKER_WIDTH = 176
MARKER_HEIGHT = 176
MARKER_ANCHOR_X = 88
MARKER_ANCHOR_Y = 88


def clamp(value, minimum, maximum):
    return min(maximum, max(minimum, value))


def distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def parse_args():
    parser = argparse.ArgumentParser(description="Track football action for a vertical highlight edit.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--moments", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--sample-fps", type=float, default=5.0)
    parser.add_argument("--image-size", type=int, default=960)
    parser.add_argument("--confidence", type=float, default=0.08)
    parser.add_argument("--output-width", type=int, default=1080)
    parser.add_argument("--output-height", type=int, default=1920)
    parser.add_argument("--window-height", type=int, default=608)
    parser.add_argument("--window-top", type=int, default=656)
    parser.add_argument("--zoom", type=float, default=1.06)
    return parser.parse_args()


def frame_detections(model, frame, image_size, confidence):
    result = model.predict(
        source=frame,
        classes=[PERSON_CLASS, SPORTS_BALL_CLASS],
        conf=confidence,
        iou=0.5,
        imgsz=image_size,
        max_det=80,
        device="cpu",
        verbose=False,
    )[0]
    people = []
    balls = []
    if result.boxes is None or len(result.boxes) == 0:
        return people, balls
    boxes = result.boxes.xyxy.cpu().numpy()
    classes = result.boxes.cls.cpu().numpy().astype(int)
    confidences = result.boxes.conf.cpu().numpy()
    height, width = frame.shape[:2]
    for box, class_id, score in zip(boxes, classes, confidences):
        x1, y1, x2, y2 = [float(value) for value in box]
        x1 = clamp(x1 / width, 0.0, 1.0)
        x2 = clamp(x2 / width, 0.0, 1.0)
        y1 = clamp(y1 / height, 0.0, 1.0)
        y2 = clamp(y2 / height, 0.0, 1.0)
        detection = {
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "cx": (x1 + x2) / 2,
            "cy": (y1 + y2) / 2,
            "confidence": float(score),
        }
        if class_id == PERSON_CLASS and y2 - y1 >= 0.035:
            people.append(detection)
        elif class_id == SPORTS_BALL_CLASS and x2 - x1 <= 0.16 and y2 - y1 <= 0.20:
            balls.append(detection)
    return people, balls


def choose_ball(candidates, predicted):
    if not candidates:
        return None
    if predicted is None:
        return max(candidates, key=lambda candidate: candidate["confidence"])
    return max(
        candidates,
        key=lambda candidate: candidate["confidence"] - 1.2 * distance((candidate["cx"], candidate["cy"]), predicted),
    )


def choose_active_player(people, action_point, previous_player):
    if not people:
        return None
    if action_point is None and previous_player is not None:
        return min(people, key=lambda person: distance((person["cx"], person["y2"]), previous_player))
    target = action_point or (0.5, 0.62)

    def foot(person):
        return (person["cx"], person["y2"])

    if previous_player is not None:
        incumbent = min(people, key=lambda person: distance(foot(person), previous_player))
        incumbent_gap = distance(foot(incumbent), previous_player)
        if action_point is None:
            return incumbent if incumbent_gap <= 0.16 else None
        challenger = min(people, key=lambda person: distance(foot(person), target))
        incumbent_action_gap = distance(foot(incumbent), target)
        challenger_action_gap = distance(foot(challenger), target)
        if incumbent_gap <= 0.13 and challenger_action_gap + 0.035 >= incumbent_action_gap * 0.72:
            return incumbent

    def score(person):
        player_foot = foot(person)
        action_distance = math.hypot(player_foot[0] - target[0], (player_foot[1] - target[1]) * 0.55)
        continuity = distance(player_foot, previous_player) if previous_player is not None else 0.0
        return action_distance + continuity * 0.42 - person["confidence"] * 0.04

    return min(people, key=score)


def smooth_values(values, times, initial, dead_zone, maximum_speed, alpha_base):
    if not values:
        return []
    output = []
    current = values[0] if math.isfinite(values[0]) else initial
    previous_time = times[0]
    for value, timestamp in zip(values, times):
        target = value if math.isfinite(value) else current
        delta = target - current
        if abs(delta) <= dead_zone:
            target = current
            delta = 0.0
        dt = max(0.001, timestamp - previous_time)
        alpha = clamp(alpha_base + abs(delta) * 1.8, alpha_base, 0.72)
        proposed = current + delta * alpha
        maximum_step = maximum_speed * dt
        current += clamp(proposed - current, -maximum_step, maximum_step)
        output.append(current)
        previous_time = timestamp
    if len(output) >= 3:
        softened = output[:]
        for index in range(1, len(output) - 1):
            softened[index] = output[index - 1] * 0.18 + output[index] * 0.64 + output[index + 1] * 0.18
        output = softened
    return output


def create_player_circle(path):
    image = np.zeros((MARKER_HEIGHT, MARKER_WIDTH, 4), dtype=np.uint8)
    center = (MARKER_ANCHOR_X, MARKER_ANCHOR_Y)
    radius = 68
    cv2.circle(image, (center[0] + 3, center[1] + 4), radius + 3, (0, 0, 0, 115), 12, cv2.LINE_AA)
    cv2.circle(image, center, radius + 2, (35, 35, 235, 55), 18, cv2.LINE_AA)
    cv2.circle(image, center, radius, (35, 35, 235, 255), 7, cv2.LINE_AA)
    cv2.circle(image, center, radius - 8, (255, 255, 255, 175), 2, cv2.LINE_AA)
    tick = 14
    gap = radius - 5
    cv2.line(image, (center[0], center[1] - gap - tick), (center[0], center[1] - gap + 3), (35, 35, 235, 255), 6, cv2.LINE_AA)
    cv2.line(image, (center[0], center[1] + gap - 3), (center[0], center[1] + gap + tick), (35, 35, 235, 255), 6, cv2.LINE_AA)
    cv2.line(image, (center[0] - gap - tick, center[1]), (center[0] - gap + 3, center[1]), (35, 35, 235, 255), 6, cv2.LINE_AA)
    cv2.line(image, (center[0] + gap - 3, center[1]), (center[0] + gap + tick, center[1]), (35, 35, 235, 255), 6, cv2.LINE_AA)
    if not cv2.imwrite(str(path), image):
        raise RuntimeError(f"Could not create the player highlight circle at {path}")


def build_keyframes(records, media_width, media_height, fallback_x, output_width, window_height, window_top, zoom):
    if not records:
        return []
    times = [record["time"] for record in records]
    camera_targets_x = [record["camera_target_x"] for record in records]
    camera_targets_y = [record["camera_target_y"] for record in records]
    marker_x_values = [record["player_x"] if record["player_x"] is not None else math.nan for record in records]
    marker_y_values = [record["player_y"] if record["player_y"] is not None else math.nan for record in records]
    base_crop_width = min(media_width, media_height * 9 / 16)
    base_crop_height = min(media_height, media_width * 16 / 9)
    crop_width = base_crop_width / zoom
    crop_height = base_crop_height / zoom
    half_x = crop_width / media_width / 2
    half_y = crop_height / media_height / 2
    camera_x = smooth_values(camera_targets_x, times, fallback_x, 0.025, 0.70, 0.27)
    camera_y = smooth_values(camera_targets_y, times, 0.5, 0.030, 0.55, 0.24)
    camera_x = [clamp(value, half_x, 1 - half_x) for value in camera_x]
    camera_y = [clamp(value, half_y, 1 - half_y) for value in camera_y]
    last_marker_x = fallback_x
    last_marker_y = 0.72
    marker_visible = []
    gap_start = None
    for index, record in enumerate(records):
        detected_marker = math.isfinite(marker_x_values[index]) and math.isfinite(marker_y_values[index])
        if detected_marker:
            last_marker_x = marker_x_values[index]
            last_marker_y = marker_y_values[index]
        else:
            marker_x_values[index] = last_marker_x
            marker_y_values[index] = last_marker_y
        if record.get("marker_suppressed", False):
            gap_start = record["time"]
            marker_visible.append(False)
        elif detected_marker:
            gap_start = None
            marker_visible.append(True)
        else:
            if gap_start is None:
                gap_start = record["time"]
            marker_visible.append(record["time"] - gap_start <= MAX_PLAYER_GAP_SECONDS)
    marker_x = smooth_values(marker_x_values, times, fallback_x, 0.008, 0.18, 0.32)
    marker_y = smooth_values(marker_y_values, times, 0.50, 0.008, 0.32, 0.30)
    camera_x = [
        clamp(clamp(camera_x[index], marker_x[index] - half_x * 0.68, marker_x[index] + half_x * 0.68), half_x, 1 - half_x)
        for index in range(len(camera_x))
    ]
    camera_y = [
        clamp(clamp(camera_y[index], marker_y[index] - half_y * 0.76, marker_y[index] + half_y * 0.76), half_y, 1 - half_y)
        for index in range(len(camera_y))
    ]
    keyframes = []
    for index, record in enumerate(records):
        crop_left = camera_x[index] * media_width - crop_width / 2
        crop_top = camera_y[index] * media_height - crop_height / 2
        projected_x = (marker_x[index] * media_width - crop_left) / crop_width * output_width
        projected_y = window_top + (marker_y[index] * media_height - crop_top) / crop_height * window_height
        marker_is_visible = marker_visible[index] and 0 <= projected_x <= output_width and window_top <= projected_y <= window_top + window_height
        output_x = clamp(projected_x - MARKER_ANCHOR_X, -MARKER_ANCHOR_X + 4, output_width - (MARKER_WIDTH - MARKER_ANCHOR_X) - 4)
        output_y = clamp(projected_y - MARKER_ANCHOR_Y, window_top - MARKER_ANCHOR_Y + 4, window_top + window_height - (MARKER_HEIGHT - MARKER_ANCHOR_Y) - 4)
        keyframes.append(
            {
                "time": round(record["time"], 3),
                "cameraX": round(camera_x[index], 6),
                "cameraY": round(camera_y[index], 6),
                "markerX": round(output_x, 2),
                "markerY": round(output_y, 2),
                "markerVisible": 1 if marker_is_visible else 0,
                "ballConfidence": round(record["ball_confidence"], 4),
            }
        )
    return keyframes


def track_moment(model, capture, moment, media_width, media_height, source_fps, sample_fps, image_size, confidence, output_width, window_height, window_top, zoom):
    start = float(moment["startTime"])
    end = float(moment["endTime"])
    fallback_x = clamp(float(moment.get("focusX", 0.5)), 0.0, 1.0)
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(start * source_fps)))
    next_sample = start
    records = []
    last_ball = None
    ball_velocity = (0.0, 0.0)
    last_ball_time = None
    last_direct_ball_time = None
    last_player = None
    previous_scene_histogram = None
    marker_suppressed_until = start
    direct_ball_frames = 0
    people_frames = 0
    sampled_frames = 0
    while True:
        success, frame = capture.read()
        if not success:
            break
        timestamp = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if timestamp >= end:
            break
        if timestamp + 0.0001 < next_sample:
            continue
        relative_time = timestamp - start
        next_sample += 1.0 / sample_fps
        sampled_frames += 1
        scene_frame = cv2.resize(frame, (96, 54), interpolation=cv2.INTER_AREA)
        scene_hsv = cv2.cvtColor(scene_frame, cv2.COLOR_BGR2HSV)
        scene_histogram = cv2.calcHist([scene_hsv], [0, 1], None, [24, 16], [0, 180, 0, 256])
        cv2.normalize(scene_histogram, scene_histogram)
        scene_cut = previous_scene_histogram is not None and cv2.compareHist(previous_scene_histogram, scene_histogram, cv2.HISTCMP_BHATTACHARYYA) >= 0.46
        previous_scene_histogram = scene_histogram
        if scene_cut:
            last_ball = None
            ball_velocity = (0.0, 0.0)
            last_ball_time = None
            last_direct_ball_time = None
            last_player = None
            marker_suppressed_until = timestamp + 0.18
        people, balls = frame_detections(model, frame, image_size, confidence)
        if people:
            people_frames += 1
        predicted_ball = None
        if last_ball is not None and last_ball_time is not None:
            dt = max(0.0, timestamp - last_ball_time)
            predicted_ball = (
                clamp(last_ball[0] + ball_velocity[0] * dt, 0.0, 1.0),
                clamp(last_ball[1] + ball_velocity[1] * dt, 0.0, 1.0),
            )
        detected_ball = choose_ball(balls, predicted_ball)
        ball_confidence = 0.0
        if detected_ball is not None:
            direct_ball_frames += 1
            measured = (detected_ball["cx"], detected_ball["cy"])
            if last_ball is not None and last_ball_time is not None:
                dt = max(0.001, timestamp - last_ball_time)
                measured_velocity = ((measured[0] - last_ball[0]) / dt, (measured[1] - last_ball[1]) / dt)
                ball_velocity = (
                    clamp(ball_velocity[0] * 0.55 + measured_velocity[0] * 0.45, -1.5, 1.5),
                    clamp(ball_velocity[1] * 0.55 + measured_velocity[1] * 0.45, -1.5, 1.5),
                )
            last_ball = measured
            last_ball_time = timestamp
            last_direct_ball_time = timestamp
            ball_confidence = detected_ball["confidence"]
        elif predicted_ball is not None and last_direct_ball_time is not None and timestamp - last_direct_ball_time <= MAX_BALL_GAP_SECONDS:
            last_ball = predicted_ball
            last_ball_time = timestamp
            ball_confidence = max(0.05, 0.25 * (1 - (timestamp - last_direct_ball_time) / MAX_BALL_GAP_SECONDS))
        else:
            last_ball = None
            ball_velocity = (0.0, 0.0)
        active_player = choose_active_player(people, last_ball, last_player)
        if active_player is not None:
            last_player = (active_player["cx"], active_player["y2"])
        people_center_x = float(np.median([person["cx"] for person in people])) if people else fallback_x
        people_center_y = float(np.median([person["cy"] for person in people])) if people else 0.5
        if last_ball is not None:
            nearby_people = [person for person in people if abs(person["cx"] - last_ball[0]) <= 0.24]
            context_x = float(np.median([person["cx"] for person in nearby_people])) if nearby_people else people_center_x
            context_y = float(np.median([person["cy"] for person in nearby_people])) if nearby_people else people_center_y
            player_x = active_player["cx"] if active_player is not None else last_ball[0]
            player_y = active_player["cy"] if active_player is not None else last_ball[1]
            lead_x = clamp(ball_velocity[0] * 0.18, -0.06, 0.06)
            lead_y = clamp(ball_velocity[1] * 0.10, -0.035, 0.035)
            camera_target_x = clamp(last_ball[0] * 0.52 + player_x * 0.28 + context_x * 0.20 + lead_x, 0.0, 1.0)
            camera_target_y = clamp(last_ball[1] * 0.42 + player_y * 0.28 + context_y * 0.30 + lead_y, 0.0, 1.0)
        elif active_player is not None:
            camera_target_x = active_player["cx"] * 0.72 + people_center_x * 0.28
            camera_target_y = active_player["cy"] * 0.58 + people_center_y * 0.42
        elif people:
            camera_target_x = float(np.median([person["cx"] for person in people]))
            camera_target_y = float(np.median([person["cy"] for person in people]))
        else:
            camera_target_x = fallback_x
            camera_target_y = 0.5
        records.append(
            {
                "time": relative_time,
                "camera_target_x": camera_target_x,
                "camera_target_y": camera_target_y,
                "player_x": active_player["cx"] if active_player is not None else None,
                "player_y": active_player["cy"] if active_player is not None else None,
                "marker_suppressed": timestamp < marker_suppressed_until,
                "ball_confidence": ball_confidence,
            }
        )
    keyframes = build_keyframes(records, media_width, media_height, fallback_x, output_width, window_height, window_top, zoom)
    denominator = max(1, sampled_frames)
    return {
        "keyframes": keyframes,
        "sampledFrames": sampled_frames,
        "ballDetectionCoverage": round(direct_ball_frames / denominator, 4),
        "playerDetectionCoverage": round(people_frames / denominator, 4),
        "highlightCoverage": round(sum(1 for frame in keyframes if frame["markerVisible"] == 1) / max(1, len(keyframes)), 4),
    }


def main():
    args = parse_args()
    with open(args.moments, "r", encoding="utf-8") as handle:
        request = json.load(handle)
    moments = request.get("moments", [])
    if not moments:
        raise RuntimeError("No selected moments were provided for tracking.")
    capture = cv2.VideoCapture(args.source)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open source video: {args.source}")
    source_fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    media_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    media_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if media_width <= 0 or media_height <= 0:
        raise RuntimeError("Could not determine source video dimensions.")
    model = YOLO(args.model)
    tracked = {}
    total_samples = 0
    weighted_ball_coverage = 0.0
    weighted_player_coverage = 0.0
    weighted_highlight_coverage = 0.0
    for index, moment in enumerate(moments):
        result = track_moment(model, capture, moment, media_width, media_height, source_fps, args.sample_fps, args.image_size, args.confidence, args.output_width, args.window_height, args.window_top, args.zoom)
        tracked[moment["id"]] = result
        samples = result["sampledFrames"]
        total_samples += samples
        weighted_ball_coverage += result["ballDetectionCoverage"] * samples
        weighted_player_coverage += result["playerDetectionCoverage"] * samples
        weighted_highlight_coverage += result["highlightCoverage"] * samples
        print(f"tracked {index + 1}/{len(moments)} moments", flush=True)
    capture.release()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    marker_path = output_path.parent / "player-circle.png"
    create_player_circle(marker_path)
    denominator = max(1, total_samples)
    payload = {
        "version": 6,
        "model": os.path.basename(args.model),
        "sampleFps": args.sample_fps,
        "markerPath": str(marker_path.resolve()),
        "moments": tracked,
        "summary": {
            "sampledFrames": total_samples,
            "ballDetectionCoverage": round(weighted_ball_coverage / denominator, 4),
            "playerDetectionCoverage": round(weighted_player_coverage / denominator, 4),
            "highlightCoverage": round(weighted_highlight_coverage / denominator, 4),
        },
    }
    temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
    with open(temporary_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary_path, output_path)
    print(json.dumps(payload["summary"]), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"tracking failed: {error}", file=sys.stderr, flush=True)
        raise
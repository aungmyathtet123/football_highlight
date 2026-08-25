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
MAX_BALL_GAP_SECONDS = 0.85
MAX_TRACK_GAP_SECONDS = 0.75
CAMERA_DEAD_ZONE = 0.028
MAX_CAMERA_SPEED = 0.34
ASSETS = {
    "arrow": {"width": 160, "height": 188, "anchor_x": 80, "anchor_y": 176},
    "spotlight": {"width": 220, "height": 244, "anchor_x": 110, "anchor_y": 122},
}


def clamp(value, minimum, maximum):
    return min(maximum, max(minimum, value))


def point_distance(a, b, vertical_weight=1.0):
    return math.hypot(a[0] - b[0], (a[1] - b[1]) * vertical_weight)


def bbox_iou(a, b):
    left, top = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    return intersection / max(1e-8, area_a + area_b - intersection)


def parse_args():
    parser = argparse.ArgumentParser(description="Track football action for a professional vertical edit.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--moments", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--sample-fps", type=float, default=8.0)
    parser.add_argument("--image-size", type=int, default=960)
    parser.add_argument("--confidence", type=float, default=0.08)
    parser.add_argument("--output-width", type=int, default=1080)
    parser.add_argument("--output-height", type=int, default=1920)
    parser.add_argument("--window-height", type=int, default=1920)
    parser.add_argument("--window-top", type=int, default=0)
    parser.add_argument("--zoom", type=float, default=1.0)
    return parser.parse_args()


def appearance_signature(frame, detection):
    height, width = frame.shape[:2]
    x1 = int(clamp(detection["x1"] * width, 0, width - 1))
    x2 = int(clamp(detection["x2"] * width, x1 + 1, width))
    y1 = int(clamp((detection["y1"] + (detection["y2"] - detection["y1"]) * 0.10) * height, 0, height - 1))
    y2 = int(clamp((detection["y1"] + (detection["y2"] - detection["y1"]) * 0.58) * height, y1 + 1, height))
    patch = frame[y1:y2, x1:x2]
    if patch.size < 48:
        return None
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv], [0, 1], None, [12, 8], [0, 180, 0, 256])
    cv2.normalize(histogram, histogram, alpha=1.0, norm_type=cv2.NORM_L1)
    return histogram


def signature_distance(a, b):
    if a is None or b is None:
        return 0.45
    return clamp(float(cv2.compareHist(a, b, cv2.HISTCMP_BHATTACHARYYA)), 0.0, 1.0)


class PersonTracker:
    def __init__(self):
        self.tracks = {}
        self.next_id = 1

    def reset(self):
        self.tracks.clear()

    def update(self, detections, frame, timestamp):
        for detection in detections:
            detection["signature"] = appearance_signature(frame, detection)
        candidates = []
        for track_id, track in self.tracks.items():
            gap = timestamp - track["time"]
            if gap > MAX_TRACK_GAP_SECONDS:
                continue
            predicted = (
                clamp(track["foot"][0] + track["velocity"][0] * gap, 0.0, 1.0),
                clamp(track["foot"][1] + track["velocity"][1] * gap, 0.0, 1.0),
            )
            for detection_index, detection in enumerate(detections):
                foot = (detection["cx"], detection["y2"])
                spatial = point_distance(foot, predicted, 0.55)
                overlap = bbox_iou(track["bbox"], detection_bbox(detection))
                appearance = signature_distance(track["signature"], detection["signature"])
                size_delta = abs((detection["y2"] - detection["y1"]) - (track["bbox"][3] - track["bbox"][1]))
                if spatial > 0.21 and overlap < 0.02:
                    continue
                cost = spatial * 0.56 + (1.0 - overlap) * 0.12 + appearance * 0.25 + size_delta * 0.07
                candidates.append((cost, track_id, detection_index))
        assigned_tracks, assigned_detections = set(), set()
        for cost, track_id, detection_index in sorted(candidates):
            if cost > 0.24 or track_id in assigned_tracks or detection_index in assigned_detections:
                continue
            self._update_track(track_id, detections[detection_index], timestamp)
            assigned_tracks.add(track_id)
            assigned_detections.add(detection_index)
        for index, detection in enumerate(detections):
            if index in assigned_detections:
                continue
            track_id = self.next_id
            self.next_id += 1
            self.tracks[track_id] = {
                "bbox": detection_bbox(detection),
                "foot": (detection["cx"], detection["y2"]),
                "velocity": (0.0, 0.0),
                "signature": detection["signature"],
                "time": timestamp,
                "hits": 1,
            }
            detection["trackId"], detection["trackAge"] = track_id, 1
        visible = {detection["trackId"] for detection in detections}
        self.tracks = {
            track_id: track for track_id, track in self.tracks.items()
            if timestamp - track["time"] <= MAX_TRACK_GAP_SECONDS or track_id in visible
        }
        return detections

    def _update_track(self, track_id, detection, timestamp):
        track = self.tracks[track_id]
        foot = (detection["cx"], detection["y2"])
        gap = max(0.001, timestamp - track["time"])
        measured = ((foot[0] - track["foot"][0]) / gap, (foot[1] - track["foot"][1]) / gap)
        track["velocity"] = (
            clamp(track["velocity"][0] * 0.64 + measured[0] * 0.36, -0.75, 0.75),
            clamp(track["velocity"][1] * 0.64 + measured[1] * 0.36, -0.75, 0.75),
        )
        track.update({"bbox": detection_bbox(detection), "foot": foot, "time": timestamp, "hits": track["hits"] + 1})
        if detection["signature"] is not None:
            track["signature"] = detection["signature"]
        detection["trackId"], detection["trackAge"] = track_id, track["hits"]


def detection_bbox(detection):
    return detection["x1"], detection["y1"], detection["x2"], detection["y2"]


def frame_detections(model, frame, image_size, confidence):
    result = model.predict(
        source=frame, classes=[PERSON_CLASS, SPORTS_BALL_CLASS], conf=confidence, iou=0.5,
        imgsz=image_size, max_det=90, device="cpu", verbose=False,
    )[0]
    people, balls = [], []
    if result.boxes is None or len(result.boxes) == 0:
        return people, balls
    height, width = frame.shape[:2]
    for box, class_id, score in zip(
        result.boxes.xyxy.cpu().numpy(),
        result.boxes.cls.cpu().numpy().astype(int),
        result.boxes.conf.cpu().numpy(),
    ):
        x1, y1, x2, y2 = [float(value) for value in box]
        x1, x2 = clamp(x1 / width, 0.0, 1.0), clamp(x2 / width, 0.0, 1.0)
        y1, y2 = clamp(y1 / height, 0.0, 1.0), clamp(y2 / height, 0.0, 1.0)
        detection = {
            "x1": x1, "y1": y1, "x2": x2, "y2": y2, "cx": (x1 + x2) / 2,
            "cy": (y1 + y2) / 2, "confidence": float(score),
        }
        if class_id == PERSON_CLASS and y2 - y1 >= 0.032:
            people.append(detection)
        elif class_id == SPORTS_BALL_CLASS and x2 - x1 <= 0.13 and y2 - y1 <= 0.16:
            balls.append(detection)
    return people, balls


def choose_ball(candidates, predicted):
    if not candidates:
        return None
    if predicted is None:
        return max(candidates, key=lambda item: item["confidence"])
    best = max(candidates, key=lambda item: item["confidence"] - 1.35 * point_distance((item["cx"], item["cy"]), predicted))
    gap = point_distance((best["cx"], best["cy"]), predicted)
    return best if gap <= 0.22 or best["confidence"] >= 0.55 else None


def player_score(person, ball, incumbent_id):
    foot = (person["cx"], person["y2"])
    proximity = point_distance(foot, ball, 0.52) if ball is not None else abs(person["cx"] - 0.5) + abs(person["cy"] - 0.57) * 0.25
    continuity = 0.095 if person.get("trackId") == incumbent_id else 0.0
    maturity = min(0.035, max(0, person.get("trackAge", 1) - 1) * 0.006)
    return proximity - continuity - maturity - person["confidence"] * 0.025


def choose_locked_player(people, ball, incumbent_id, pending_id, pending_count):
    if not people:
        return None, incumbent_id, None, 0
    challenger = min(people, key=lambda person: player_score(person, ball, incumbent_id))
    incumbent = next((person for person in people if person.get("trackId") == incumbent_id), None)
    if incumbent is None:
        return challenger, challenger["trackId"], None, 0
    if challenger["trackId"] == incumbent_id:
        return incumbent, incumbent_id, None, 0
    if player_score(challenger, ball, incumbent_id) + 0.055 < player_score(incumbent, ball, incumbent_id):
        count = pending_count + 1 if challenger["trackId"] == pending_id else 1
        if count >= 3:
            return challenger, challenger["trackId"], None, 0
        return incumbent, incumbent_id, challenger["trackId"], count
    return incumbent, incumbent_id, None, 0


def weighted_center(items, fallback):
    total = sum(weight for _, weight in items)
    return sum(value * weight for value, weight in items) / total if total else fallback


def action_target(people, ball, active, velocity, fallback_x, view_width):
    people_x = float(np.median([person["cx"] for person in people])) if people else fallback_x
    people_y = float(np.median([person["cy"] for person in people])) if people else 0.52
    if ball is None:
        if active is None:
            return people_x, people_y, 0.0
        return active["cx"] * 0.76 + people_x * 0.24, active["cy"] * 0.72 + people_y * 0.28, 0.0
    nearby = sorted(people, key=lambda person: point_distance((person["cx"], person["cy"]), ball, 0.55))[:5]
    direction = 1 if velocity[0] > 0.025 else -1 if velocity[0] < -0.025 else 0
    ahead = [person for person in people if direction and (person["cx"] - ball[0]) * direction > 0.04]
    destination = min(ahead, key=lambda person: abs(person["cx"] - ball[0] - direction * 0.16) + abs(person["cy"] - ball[1]) * 0.25) if ahead else None
    x_items, y_items = [(ball[0], 3.2)], [(ball[1], 2.6)]
    if active is not None:
        x_items.append((active["cx"], 2.5))
        y_items.append((active["cy"], 2.0))
    if destination is not None and (active is None or destination["trackId"] != active["trackId"]):
        x_items.append((destination["cx"], 1.25))
        y_items.append((destination["cy"], 0.85))
    for person in nearby:
        if active is not None and person["trackId"] == active["trackId"]:
            continue
        x_items.append((person["cx"], 0.38))
        y_items.append((person["cy"], 0.26))
    target_x = clamp(weighted_center(x_items, fallback_x) + clamp(velocity[0] * 0.24, -0.075, 0.075), 0.0, 1.0)
    target_y = clamp(weighted_center(y_items, 0.5) + clamp(velocity[1] * 0.14, -0.045, 0.045), 0.0, 1.0)
    spread = max(value for value, _ in x_items) - min(value for value, _ in x_items)
    if ball is not None and active is not None:
        margin = min(0.045, view_width * 0.11)
        joint_left = min(ball[0], active["x1"])
        joint_right = max(ball[0], active["x2"])
        joint_span = joint_right - joint_left
        spread = max(spread, joint_span)
        if joint_span + margin * 2 <= view_width:
            half_view = view_width / 2
            minimum_center = joint_right + margin - half_view
            maximum_center = joint_left - margin + half_view
            target_x = clamp(target_x, minimum_center, maximum_center)
    return target_x, target_y, spread


def smooth_camera(values, times, resets, initial, half_window, sample_fps):
    if not values:
        return []
    lookahead = max(1, round(sample_fps * 0.30))
    targets = [value * 0.68 + values[min(len(values) - 1, index + lookahead)] * 0.32 for index, value in enumerate(values)]
    output, current, previous_time = [], targets[0] if math.isfinite(targets[0]) else initial, times[0]
    for index, (target, timestamp) in enumerate(zip(targets, times)):
        if resets[index]:
            current = target
        delta = target - current
        if abs(delta) < CAMERA_DEAD_ZONE:
            delta = 0.0
        step = delta * clamp(0.16 + abs(delta) * 0.82, 0.16, 0.48)
        current += clamp(step, -MAX_CAMERA_SPEED * max(0.001, timestamp - previous_time), MAX_CAMERA_SPEED * max(0.001, timestamp - previous_time))
        current = clamp(current, half_window, 1.0 - half_window)
        output.append(current)
        previous_time = timestamp
    if len(output) >= 5:
        softened = output[:]
        for index in range(2, len(output) - 2):
            if any(resets[index - 2:index + 3]):
                continue
            softened[index] = sum(output[index + offset] * weight for offset, weight in zip(range(-2, 3), [1, 2, 3, 2, 1])) / 9
        output = softened
    return output


def create_arrow(path):
    image = np.zeros((188, 160, 4), dtype=np.uint8)
    points = np.array([[58, 18], [102, 18], [102, 112], [136, 112], [80, 176], [24, 112], [58, 112]], np.int32)
    cv2.fillPoly(image, [points + np.array([4, 5])], (0, 0, 0, 150), cv2.LINE_AA)
    cv2.fillPoly(image, [points], (45, 242, 210, 255), cv2.LINE_AA)
    cv2.polylines(image, [points], True, (255, 255, 255, 235), 4, cv2.LINE_AA)
    if not cv2.imwrite(str(path), image):
        raise RuntimeError(f"Could not create player arrow at {path}")


def create_spotlight(path):
    image = np.zeros((244, 220, 4), dtype=np.uint8)
    for offset, stroke, color in [(5, 12, (0, 0, 0, 150)), (0, 7, (45, 242, 210, 255))]:
        left, right, top, bottom, arm = 22, 198, 30, 222, 46
        segments = [
            ((left + offset, top + arm + offset), (left + offset, top + offset)), ((left + offset, top + offset), (left + arm + offset, top + offset)),
            ((right + offset, top + arm + offset), (right + offset, top + offset)), ((right - arm + offset, top + offset), (right + offset, top + offset)),
            ((left + offset, bottom - arm + offset), (left + offset, bottom + offset)), ((left + offset, bottom + offset), (left + arm + offset, bottom + offset)),
            ((right + offset, bottom - arm + offset), (right + offset, bottom + offset)), ((right - arm + offset, bottom + offset), (right + offset, bottom + offset)),
        ]
        for start, end in segments:
            cv2.line(image, start, end, color, stroke, cv2.LINE_AA)
    cv2.circle(image, (110, 122), 9, (255, 255, 255, 230), 3, cv2.LINE_AA)
    if not cv2.imwrite(str(path), image):
        raise RuntimeError(f"Could not create player spotlight at {path}")


def build_keyframes(records, media_width, media_height, fallback_x, output_width, window_height, window_top, zoom, sample_fps):
    if not records:
        return [], {"style": "none", "confidence": 0.0, "duration": 0.0}
    times = [record["time"] for record in records]
    resets = [record["scene_cut"] for record in records]
    crop_width = min(media_width, media_height * 9 / 16) / zoom
    crop_height = min(media_height, media_width * 16 / 9) / zoom
    half_x, half_y = crop_width / media_width / 2, crop_height / media_height / 2
    camera_x = smooth_camera([record["camera_target_x"] for record in records], times, resets, fallback_x, half_x, sample_fps)
    camera_y = smooth_camera([record["camera_target_y"] for record in records], times, resets, 0.5, half_y, sample_fps)
    keyframes = [{
        "time": round(record["time"], 3), "cameraX": round(camera_x[index], 6), "cameraY": round(camera_y[index], 6),
        "ballConfidence": round(record["ball_confidence"], 4), "subjectConfidence": round(record["subject_confidence"], 4), "jointVisible": 1 if record["joint_visible"] else 0,
        "sceneCut": 1 if record["scene_cut"] else 0,
    } for index, record in enumerate(records)]
    annotation = {"style": "none", "confidence": 0.0, "duration": 0.0}
    first_record = records[0]
    opening_joint_fit = (
        first_record["player_track_id"] is not None
        and first_record["direct_ball"]
        and first_record["joint_span"] + min(0.09, crop_width / media_width * 0.22) <= crop_width / media_width
    )
    intro = [first_record] if opening_joint_fit else []
    if intro:
        first = intro[0]
        same = [record for record in intro if record["player_track_id"] == first["player_track_id"]]
        continuity = len(same) / max(1, len(intro))
        confidence = clamp(float(np.median([record["subject_confidence"] for record in same])) * 0.58 + continuity * 0.22 + clamp(first["ball_confidence"] / 0.45, 0.0, 1.0) * 0.20, 0.0, 1.0)
        index = records.index(first)
        crop_left = camera_x[index] * media_width - crop_width / 2
        crop_top = camera_y[index] * media_height - crop_height / 2
        projected_x = (first["player_x"] * media_width - crop_left) / crop_width * output_width
        center_y = window_top + (first["player_y"] * media_height - crop_top) / crop_height * window_height
        top_y = window_top + (first["player_top"] * media_height - crop_top) / crop_height * window_height
        style = "spotlight" if confidence >= 0.70 else "arrow" if confidence >= 0.54 else "none"
        if style != "none":
            asset = ASSETS[style]
            x = projected_x - asset["anchor_x"]
            y = (center_y if style == "spotlight" else top_y) - asset["anchor_y"]
            if -asset["width"] * 0.25 <= x <= output_width - asset["width"] * 0.75 and window_top - asset["height"] * 0.25 <= y <= window_top + window_height - asset["height"] * 0.75:
                annotation = {
                    "style": style, "confidence": round(confidence, 4), "duration": 0.68 if style == "spotlight" else 0.56,
                    "x": round(clamp(x, -asset["width"] * 0.15, output_width - asset["width"] * 0.85), 2),
                    "y": round(clamp(y, window_top - asset["height"] * 0.10, window_top + window_height - asset["height"] * 0.90), 2),
                    "sourceX": round(first["player_x"], 6),
                    "sourceYTop": round(first["player_top"], 6),
                    "sourceYCenter": round(first["player_y"], 6),
                    "trackId": first["player_track_id"],
                }
    return keyframes, annotation


def track_moment(model, capture, moment, media_width, media_height, source_fps, args):
    start, end = float(moment["startTime"]), float(moment["endTime"])
    fallback_x = clamp(float(moment.get("focusX", 0.5)), 0.0, 1.0)
    view_width = min(media_width, media_height * 9 / 16) / args.zoom / media_width
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(start * source_fps)))
    next_sample, records = start, []
    last_ball = last_ball_time = last_direct_ball_time = None
    ball_velocity = (0.0, 0.0)
    tracker = PersonTracker()
    subject_id = pending_id = None
    pending_count = 0
    previous_histogram = None
    direct_ball_frames = people_frames = sampled_frames = 0
    while True:
        success, frame = capture.read()
        if not success:
            break
        timestamp = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if timestamp >= end:
            break
        if timestamp + 0.0001 < next_sample:
            continue
        next_sample += 1.0 / args.sample_fps
        sampled_frames += 1
        thumbnail = cv2.cvtColor(cv2.resize(frame, (96, 54), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2HSV)
        histogram = cv2.calcHist([thumbnail], [0, 1], None, [24, 16], [0, 180, 0, 256])
        cv2.normalize(histogram, histogram)
        scene_cut = previous_histogram is not None and cv2.compareHist(previous_histogram, histogram, cv2.HISTCMP_BHATTACHARYYA) >= 0.46
        previous_histogram = histogram
        if scene_cut:
            last_ball = last_ball_time = last_direct_ball_time = None
            ball_velocity = (0.0, 0.0)
            subject_id = pending_id = None
            pending_count = 0
            tracker.reset()
        people, balls = frame_detections(model, frame, args.image_size, args.confidence)
        people = tracker.update(people, frame, timestamp)
        people_frames += 1 if people else 0
        predicted = None
        if last_ball is not None and last_ball_time is not None:
            gap = max(0.0, timestamp - last_ball_time)
            predicted = (clamp(last_ball[0] + ball_velocity[0] * gap, 0.0, 1.0), clamp(last_ball[1] + ball_velocity[1] * gap, 0.0, 1.0))
        detected = choose_ball(balls, predicted)
        direct_ball, ball_confidence = detected is not None, 0.0
        if detected is not None:
            direct_ball_frames += 1
            measured = (detected["cx"], detected["cy"])
            if last_ball is not None and last_ball_time is not None:
                gap = max(0.001, timestamp - last_ball_time)
                measured_velocity = ((measured[0] - last_ball[0]) / gap, (measured[1] - last_ball[1]) / gap)
                ball_velocity = (
                    clamp(ball_velocity[0] * 0.60 + measured_velocity[0] * 0.40, -1.1, 1.1),
                    clamp(ball_velocity[1] * 0.60 + measured_velocity[1] * 0.40, -1.1, 1.1),
                )
            last_ball, last_ball_time, last_direct_ball_time = measured, timestamp, timestamp
            ball_confidence = float(detected["confidence"])
        elif predicted is not None and last_direct_ball_time is not None and timestamp - last_direct_ball_time <= MAX_BALL_GAP_SECONDS:
            last_ball, last_ball_time = predicted, timestamp
            ball_confidence = max(0.04, 0.20 * (1 - (timestamp - last_direct_ball_time) / MAX_BALL_GAP_SECONDS))
        else:
            last_ball, ball_velocity = None, (0.0, 0.0)
        active, subject_id, pending_id, pending_count = choose_locked_player(people, last_ball, subject_id, pending_id, pending_count)
        if active is not None:
            proximity = point_distance((active["cx"], active["y2"]), last_ball) if last_ball is not None else 0.5
            proximity_score = clamp(1.0 - proximity / 0.20, 0.0, 1.0)
            maturity = clamp(active.get("trackAge", 1) / 5.0, 0.0, 1.0)
            ball_quality = clamp(ball_confidence / 0.45, 0.0, 1.0) if direct_ball else clamp(ball_confidence / 0.20, 0.0, 0.55)
            subject_confidence = clamp(active["confidence"] * 0.30 + proximity_score * 0.28 + maturity * 0.22 + ball_quality * 0.20, 0.0, 1.0)
        else:
            subject_confidence = 0.0
        target_x, target_y, spread = action_target(people, last_ball, active, ball_velocity, fallback_x, view_width)
        joint_visible = last_ball is not None and active is not None
        joint_span = max(last_ball[0], active["x2"]) - min(last_ball[0], active["x1"]) if joint_visible else 1.0
        records.append({
            "time": timestamp - start, "camera_target_x": target_x, "camera_target_y": target_y, "action_spread": spread,
            "player_x": active["cx"] if active is not None else None, "player_y": active["cy"] if active is not None else None,
            "player_top": active["y1"] if active is not None else None, "player_track_id": active.get("trackId") if active is not None else None,
            "ball_x": last_ball[0] if last_ball is not None else None, "ball_y": last_ball[1] if last_ball is not None else None,
            "direct_ball": direct_ball, "joint_visible": joint_visible, "joint_span": joint_span,
            "subject_confidence": subject_confidence, "scene_cut": scene_cut, "ball_confidence": ball_confidence,
        })
    keyframes, annotation = build_keyframes(
        records, media_width, media_height, fallback_x, args.output_width, args.window_height,
        args.window_top, args.zoom, args.sample_fps,
    )
    denominator = max(1, sampled_frames)
    spreads = [record["action_spread"] for record in records if record["action_spread"] > 0]
    spread_p90 = float(np.percentile(spreads, 90)) if spreads else 0.0
    subject_frames = sum(record["subject_confidence"] >= 0.48 for record in records)
    joint_frames = sum(record["joint_visible"] for record in records)
    joint_margin = min(0.09, view_width * 0.22)
    joint_fit_frames = sum(record["joint_visible"] and record["joint_span"] + joint_margin <= view_width for record in records)
    opening_joint_visible = bool(
        records
        and records[0]["direct_ball"]
        and records[0]["player_track_id"] is not None
        and records[0]["joint_span"] + joint_margin <= view_width
    )
    player_only_allowed = moment.get("eventType") == "celebration" or moment.get("storyPhase") == "reaction" or moment.get("role") == "reaction"
    requires_joint_framing = not player_only_allowed
    joint_fit_coverage = joint_fit_frames / denominator
    use_context = spread_p90 > view_width * 0.82 or (
        requires_joint_framing and (not opening_joint_visible or joint_fit_coverage < 0.70)
    )
    return {
        "keyframes": keyframes, "annotation": annotation, "layoutMode": "context" if use_context else "action",
        "requiresJointFraming": requires_joint_framing, "openingJointVisible": opening_joint_visible,
        "actionSpreadP90": round(spread_p90, 4), "sampledFrames": sampled_frames,
        "ballDetectionCoverage": round(direct_ball_frames / denominator, 4),
        "playerDetectionCoverage": round(people_frames / denominator, 4),
        "jointVisibilityCoverage": round(joint_frames / denominator, 4),
        "jointFitCoverage": round(joint_fit_coverage, 4),
        "subjectLockCoverage": round(subject_frames / denominator, 4),
        "highlightCoverage": round(annotation["duration"] / max(0.001, end - start), 4),
    }


def main():
    args = parse_args()
    with open(args.moments, "r", encoding="utf-8") as handle:
        moments = json.load(handle).get("moments", [])
    if not moments:
        raise RuntimeError("No selected moments were provided for tracking.")
    capture = cv2.VideoCapture(args.source)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open source video: {args.source}")
    source_fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    media_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    media_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if media_width <= 0 or media_height <= 0:
        raise RuntimeError("Could not determine source dimensions.")
    model = YOLO(args.model)
    tracked = {}
    totals = {"samples": 0, "ball": 0.0, "player": 0.0, "joint": 0.0, "joint_fit": 0.0, "subject": 0.0, "highlight": 0.0}
    for index, moment in enumerate(moments):
        result = track_moment(model, capture, moment, media_width, media_height, source_fps, args)
        tracked[moment["id"]] = result
        samples = result["sampledFrames"]
        totals["samples"] += samples
        totals["ball"] += result["ballDetectionCoverage"] * samples
        totals["player"] += result["playerDetectionCoverage"] * samples
        totals["joint"] += result["jointVisibilityCoverage"] * samples
        totals["joint_fit"] += result["jointFitCoverage"] * samples
        totals["subject"] += result["subjectLockCoverage"] * samples
        totals["highlight"] += result["highlightCoverage"] * samples
        print(f"tracked {index + 1}/{len(moments)} moments", flush=True)
    capture.release()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    marker_paths = {"arrow": output_path.parent / "player-arrow.png", "spotlight": output_path.parent / "player-spotlight.png"}
    create_arrow(marker_paths["arrow"])
    create_spotlight(marker_paths["spotlight"])
    denominator = max(1, totals["samples"])
    payload = {
        "version": 8, "model": os.path.basename(args.model), "sampleFps": args.sample_fps,
        "markerPaths": {key: str(path.resolve()) for key, path in marker_paths.items()}, "moments": tracked,
        "summary": {
            "sampledFrames": totals["samples"], "ballDetectionCoverage": round(totals["ball"] / denominator, 4),
            "playerDetectionCoverage": round(totals["player"] / denominator, 4),
            "jointVisibilityCoverage": round(totals["joint"] / denominator, 4),
            "jointFitCoverage": round(totals["joint_fit"] / denominator, 4),
            "subjectLockCoverage": round(totals["subject"] / denominator, 4),
            "highlightCoverage": round(totals["highlight"] / denominator, 4),
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

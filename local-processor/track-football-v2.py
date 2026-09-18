import argparse
import json
import math
import os
import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO
from football_detection import PersonTracker as MotionPersonTracker, SlicedBallDetector
from tracking_motion import active_joint_fit_in_crop, camera_ownership_phase, constrained_camera, framing_bounds, vertical_framing_bounds, flight_target, visible_in_crop, observed_payoff_box, possession_handoff, goal_outcome_subject, goal_outcome_target, reconcile_goal_destination
from tracking_cache import ObservationStore, fingerprint, content_fingerprint, scene_key, atomic_json
from ball_trajectory import choose_trajectory, trajectory_camera_guidance
from phase_quality import phase_quality
from scorer_tracking import player_ball_distance, select_scorer_track_id, select_stable_action_track_id

PERSON_CLASS = 0
FOOTBALL_BALL_CLASS = 0
MAX_BALL_GAP_SECONDS = 0.45
GOAL_BALL_GAP_SECONDS = 0.45
MAX_TRACK_GAP_SECONDS = 0.75
CAMERA_DEAD_ZONE = 0.065
MAX_CAMERA_SPEED = 0.18
MIN_VISIBLE_BALL_DIAMETER = 4.0
MAX_VISIBLE_BALL_DIAMETER = 70.0
MAX_POSSESSION_DISTANCE = 0.10
ASSETS = {
    "arrow": {"width": 160, "height": 188, "anchor_x": 80, "anchor_y": 176},
    "ring": {"width": 320, "height": 320, "anchor_x": 160, "anchor_y": 160},
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
    parser.add_argument("--ball-model", required=True)
    parser.add_argument("--sample-fps", type=float, default=8.0)
    parser.add_argument("--coarse-sample-fps", type=float, default=5.0)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--image-size", type=int, default=960)
    parser.add_argument("--ball-image-size", type=int, default=1280)
    parser.add_argument("--confidence", type=float, default=0.08)
    parser.add_argument("--ball-confidence", type=float, default=0.03)
    parser.add_argument("--output-width", type=int, default=1080)
    parser.add_argument("--output-height", type=int, default=1920)
    parser.add_argument("--window-height", type=int, default=1920)
    parser.add_argument("--window-top", type=int, default=0)
    parser.add_argument("--zoom", type=float, default=1.0)
    parser.add_argument("--shots")
    parser.add_argument("--cache-dir")
    parser.add_argument("--tracker", choices=["tracktrack", "botsort", "bytetrack"], default="tracktrack")
    parser.add_argument("--camera-motion", choices=["sparseOptFlow", "none"], default="sparseOptFlow")
    parser.add_argument("--moment-id", help="Track only one moment from a larger saved job (diagnostic use).")
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


def pitch_support(hsv_frame, cx, cy, radius_x, radius_y):
    height, width = hsv_frame.shape[:2]
    left = int(clamp((cx - radius_x) * width, 0, width - 1))
    right = int(clamp((cx + radius_x) * width, left + 1, width))
    top = int(clamp((cy - radius_y) * height, 0, height - 1))
    bottom = int(clamp((cy + radius_y) * height, top + 1, height))
    patch = hsv_frame[top:bottom, left:right]
    if patch.size == 0:
        return 0.0
    green = cv2.inRange(patch, np.array([28, 36, 28]), np.array([98, 255, 255]))
    return float(np.count_nonzero(green)) / max(1, green.size)


def brief_local_time(moment, field, fallback):
    value = moment.get("trackingBrief", {}).get(field)
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        return fallback
    return clamp(float(value) - float(moment["startTime"]), 0.0, float(moment["endTime"]) - float(moment["startTime"]))


def action_phase(elapsed, contact_time, flight_time, payoff_time):
    if elapsed < contact_time:
        return "setup"
    if elapsed < flight_time:
        return "contact"
    if elapsed < payoff_time:
        return "flight"
    return "payoff"


def adaptive_sample_rate(elapsed, duration, contact_time, payoff_time, dense_fps, coarse_fps):
    """Keep dense evidence where continuity matters; scan quiet setup cheaply."""
    dense_fps = max(1.0, float(dense_fps))
    coarse_fps = min(dense_fps, max(1.0, float(coarse_fps)))
    if duration <= 6.0 or elapsed <= 1.0:
        return dense_fps
    action_start = max(0.0, contact_time - 1.75)
    action_end = min(duration, payoff_time + 1.25)
    return dense_fps if action_start <= elapsed <= action_end else coarse_fps


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


def frame_detections(person_model, ball_model, frame, image_size, ball_image_size, confidence, ball_confidence, predicted=None, device="cpu"):
    person_result = person_model.predict(
        source=frame, classes=[PERSON_CLASS], conf=confidence, iou=0.5,
        imgsz=image_size, max_det=90, device=device, verbose=False,
    )[0]
    ball_boxes = ball_model.detect(frame, predicted)
    people, balls = [], []
    height, width = frame.shape[:2]
    hsv_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    person_boxes = [] if person_result.boxes is None else zip(
        person_result.boxes.xyxy.cpu().numpy(), person_result.boxes.conf.cpu().numpy(),
    )
    for box, score in person_boxes:
        x1, y1, x2, y2 = [float(value) for value in box]
        x1, x2 = clamp(x1 / width, 0.0, 1.0), clamp(x2 / width, 0.0, 1.0)
        y1, y2 = clamp(y1 / height, 0.0, 1.0), clamp(y2 / height, 0.0, 1.0)
        detection = {
            "x1": x1, "y1": y1, "x2": x2, "y2": y2, "cx": (x1 + x2) / 2,
            "cy": (y1 + y2) / 2, "confidence": float(score),
        }
        detection["pitchSupport"] = pitch_support(
            hsv_frame, detection["cx"], min(0.995, detection["y2"] + 0.008),
            max(0.018, (x2 - x1) * 0.62), max(0.012, (y2 - y1) * 0.08),
        )
        if y2 - y1 >= 0.032:
            people.append(detection)
    for box, score in ball_boxes:
        x1, y1, x2, y2 = [float(value) for value in box]
        x1, x2 = clamp(x1 / width, 0.0, 1.0), clamp(x2 / width, 0.0, 1.0)
        y1, y2 = clamp(y1 / height, 0.0, 1.0), clamp(y2 / height, 0.0, 1.0)
        detection = {
            "x1": x1, "y1": y1, "x2": x2, "y2": y2, "cx": (x1 + x2) / 2,
            "cy": (y1 + y2) / 2, "confidence": float(score),
        }
        detection["pitchSupport"] = pitch_support(
            hsv_frame, detection["cx"], detection["cy"],
            max(0.018, (x2 - x1) * 3.5), max(0.022, (y2 - y1) * 3.5),
        )
        if x2 - x1 <= 0.13 and y2 - y1 <= 0.16:
            balls.append(detection)
    return people, balls


def choose_ball(candidates, predicted):
    if not candidates:
        return None
    if predicted is None:
        on_pitch = [
            item for item in candidates
            if item.get("pitchSupport", 0.0) >= 0.10 or item.get("nearestOnPitchPlayerDistance", 1.0) <= 0.11 or item.get("payoffSupported", False)
        ]
        pool = on_pitch
        if not pool:
            return None
        return max(
            pool,
            key=lambda item: item["confidence"] + item.get("pitchSupport", 0.0) * 0.48
            - item.get("nearestOnPitchPlayerDistance", 1.0) * 0.52,
        )
    # Football-specific models can mistake bright boots for the ball. Once a path
    # exists, continuity must beat a single high-confidence but unrelated boot.
    best = max(candidates, key=lambda item: item["confidence"] - 5.5 * point_distance((item["cx"], item["cy"]), predicted))
    airborne = [item for item in candidates if item.get("nearest_player_distance", 0.0) >= 0.065 and item["confidence"] >= 0.65]
    if airborne and best["confidence"] < 0.45:
        flight = max(airborne, key=lambda item: item["confidence"] - 2.2 * point_distance((item["cx"], item["cy"]), predicted))
        if point_distance((flight["cx"], flight["cy"]), predicted) <= 0.25:
            return flight
    gap = point_distance((best["cx"], best["cy"]), predicted)
    return best if gap <= 0.22 else None


def player_score(person, ball, incumbent_id):
    foot = (person["cx"], person["y2"])
    # The ball must be beside the player's boots in both axes. A weak vertical
    # weight allowed a large foreground defender whose boots were far below the
    # real ball to beat the true carrier in behind-goal replays.
    proximity = point_distance(foot, ball, 0.85) if ball is not None else abs(person["cx"] - 0.5) + abs(person["cy"] - 0.57) * 0.25
    continuity = 0.20 if person.get("trackId") == incumbent_id else 0.0
    maturity = min(0.035, max(0, person.get("trackAge", 1) - 1) * 0.006)
    off_pitch_penalty = max(0.0, 0.16 - person.get("pitchSupport", 0.0)) * 0.32
    return proximity - continuity - maturity - person["confidence"] * 0.025 + off_pitch_penalty


def choose_locked_player(people, ball, incumbent_id, pending_id, pending_count, view_width, allow_handoff=True):
    if not people:
        return None, incumbent_id, None, 0
    pitch_people = [person for person in people if person.get("pitchSupport", 0.0) >= 0.08]
    # Crowd, bench and advertising-area people are never valid ball carriers.
    # Keeping an identity id is useful across a brief detector miss, but an
    # off-pitch box must not steer the crop or become the visible subject.
    if not pitch_people:
        return None, incumbent_id, None, 0
    eligible_people = pitch_people
    challenger = min(eligible_people, key=lambda person: player_score(person, ball, incumbent_id))
    nearest_to_ball = min(
        eligible_people,
        key=lambda person: point_distance((person["cx"], person["y2"]), ball, 0.85),
    ) if ball is not None else challenger
    joint_margin = min(0.056, view_width * 0.15)
    frameable_people = [
        person for person in eligible_people
        if ball is not None
        and max(ball[0], person["x2"]) - min(ball[0], person["x1"]) + joint_margin * 2 <= view_width
    ]
    framing_player = min(
        frameable_people,
        # Possession is established at the player's feet, not the center of a
        # large body box. Center-distance favored a defender standing between
        # the camera and the real ball carrier in behind-goal replays.
        key=lambda person: point_distance((person["cx"], person["y2"]), ball, 0.85),
    ) if frameable_people else None
    incumbent = next((person for person in eligible_people if person.get("trackId") == incumbent_id), None)
    if incumbent is None:
        preferred = framing_player or challenger
        # Never make one ambiguous detection permanent. Keep using the current
        # best player for temporary framing, but lock ownership only after the
        # same track wins three consecutive observations.
        count = pending_count + 1 if preferred["trackId"] == pending_id else 1
        if count >= 3:
            return preferred, preferred["trackId"], None, 0
        return preferred, None, preferred["trackId"], count
    if not allow_handoff:
        # A pre-contact identity lock is stable, not irreversible. Correct an
        # early false-boot lock after two consecutive frames show another
        # player's feet materially closer to the observed ball. This repairs
        # the crop in place without returning to scene discovery.
        if ball is not None and nearest_to_ball["trackId"] != incumbent_id:
            incumbent_gap = point_distance((incumbent["cx"], incumbent["y2"]), ball, 0.85)
            nearest_gap = point_distance((nearest_to_ball["cx"], nearest_to_ball["y2"]), ball, 0.85)
            if nearest_gap <= 0.105 and nearest_gap + 0.025 < incumbent_gap:
                count = pending_count + 1 if nearest_to_ball["trackId"] == pending_id else 1
                if count >= 2:
                    return nearest_to_ball, nearest_to_ball["trackId"], None, 0
                return incumbent, incumbent_id, nearest_to_ball["trackId"], count
        return incumbent, incumbent_id, None, 0
    transfer = possession_handoff(eligible_people, ball, incumbent, pending_id, pending_count)
    if transfer:
        receiver, count = transfer
        if count >= 3:
            return receiver, receiver["trackId"], None, 0
        return incumbent, incumbent_id, receiver["trackId"], count
    incumbent_frameable = incumbent in frameable_people
    if ball is not None and framing_player is not None and not incumbent_frameable:
        gap = point_distance((framing_player["cx"], framing_player["y2"]), ball, 0.52)
        count = pending_count + 1 if framing_player["trackId"] == pending_id else 1
        if gap <= 0.12 and count >= 3:
            return framing_player, framing_player["trackId"], None, 0
        return incumbent, incumbent_id, framing_player["trackId"], count
    if challenger["trackId"] == incumbent_id:
        return incumbent, incumbent_id, None, 0
    incumbent_gap = point_distance((incumbent["cx"], incumbent["y2"]), ball, 0.52) if ball is not None else 0.0
    nearest_gap = point_distance((nearest_to_ball["cx"], nearest_to_ball["y2"]), ball, 0.52) if ball is not None else 1.0
    if ball is not None and incumbent_gap > 0.13 and nearest_gap + 0.035 < incumbent_gap:
        return nearest_to_ball, nearest_to_ball["trackId"], None, 0
    if player_score(challenger, ball, incumbent_id) + 0.11 < player_score(incumbent, ball, incumbent_id):
        count = pending_count + 1 if challenger["trackId"] == pending_id else 1
        if count >= 5:
            return challenger, challenger["trackId"], None, 0
        return incumbent, incumbent_id, challenger["trackId"], count
    return incumbent, incumbent_id, None, 0


def weighted_center(items, fallback):
    total = sum(weight for _, weight in items)
    return sum(value * weight for value, weight in items) / total if total else fallback


def action_target(people, ball, active, velocity, fallback_x, view_width, goal_mode=False, phase="setup"):
    if ball is None:
        # A person detection is not enough to move a football camera. When the
        # ball is occluded, hold the last verified action position until the
        # trajectory or a verified goalmouth handoff becomes available.
        return fallback_x, 0.5, 0.0
    if active is None and phase in {"setup", "contact"}:
        # A tiny ball-like detection cannot establish composition by itself
        # before contact. Hold the current shot's verified action anchor until
        # a player/ball pair is linked; otherwise a boot, line marking, or
        # advertising detail can pull a full-bleed crop onto empty grass.
        prominent = max(
            (person for person in people if person.get("pitchSupport", 0.0) >= .08),
            key=lambda person: (person["x2"] - person["x1"]) * (person["y2"] - person["y1"]),
            default=None,
        )
        prominent_area = ((prominent["x2"] - prominent["x1"]) * (prominent["y2"] - prominent["y1"])
                          if prominent is not None else 0.0)
        if prominent is not None and prominent_area >= .035:
            # In close-ups the ball is often held against a goalkeeper's body
            # and missed by the tiny-object model. A single dominant on-pitch
            # person is stronger evidence than a remote logo-like ball hit.
            return prominent["cx"], prominent["cy"], prominent["x2"] - prominent["x1"]
        return fallback_x, 0.5, 0.0
    if active is not None and phase in {"setup", "contact"}:
        # The football is the primary camera subject. Keep the complete
        # involved player inside the safe crop, but do not average the camera
        # toward unrelated bodies or empty space between a wide player/ball
        # pair. The visibility clamp below preserves both subjects.
        joint_left = min(ball[0], active["x1"])
        joint_right = max(ball[0], active["x2"])
        joint_span = joint_right - joint_left
        margin = min(0.035, view_width * 0.11)
        lead = clamp(velocity[0] * 0.06, -0.012, 0.012)
        target_x = ball[0] * .72 + active["cx"] * .28 + lead
        if joint_span + margin * 2 <= view_width:
            half_view = view_width / 2
            target_x = clamp(target_x, joint_right + margin - half_view, joint_left - margin + half_view)
        target_y = weighted_center([(ball[1], 2.8), (active["cy"], 2.2)], 0.5)
        return clamp(target_x, 0.0, 1.0), clamp(target_y, 0.0, 1.0), joint_span
    # Never infer a camera destination from unrelated nearby players. The
    # verified player/ball pair owns setup and contact; after contact the ball
    # owns the pan until goal_outcome_target performs a verified keeper/goal
    # handoff. This prevents the portrait crop from abandoning the shot.
    ball_weight = 4.4 if goal_mode else 3.2
    x_items, y_items = [(ball[0], ball_weight)], [(ball[1], 3.4 if goal_mode else 2.6)]
    if active is not None and phase in {"setup", "contact"}:
        x_items.append((active["cx"], 2.5))
        y_items.append((active["cy"], 2.0))
    # Follow the observed football, not an aggressive extrapolation toward the
    # goalkeeper. A small lead keeps motion fluid without showing the outcome
    # before the pass or shot arrives.
    velocity_lookahead = 0.14 if goal_mode else 0.10
    target_x = clamp(weighted_center(x_items, fallback_x) + clamp(velocity[0] * velocity_lookahead, -0.04, 0.04), 0.0, 1.0)
    target_y = clamp(weighted_center(y_items, 0.5) + clamp(velocity[1] * 0.14, -0.045, 0.045), 0.0, 1.0)
    spread = max(value for value, _ in x_items) - min(value for value, _ in x_items)
    if ball is not None and active is not None and phase in {"setup", "contact"}:
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


def adaptive_scene_zoom(records, media_width, media_height, output_width, window_height):
    """Keep gameplay at the minimum full-bleed scale.

    The aspect-ratio crop already enlarges a 16:9 source by 177.78% for a
    9:16 output.  Additional per-scene zoom removes football context and makes
    detector noise look like zoom pumping.  Intentional analytical punch zooms
    remain a renderer effect and never alter the verified tracking viewport.
    """
    return 1.0


def smooth_camera(values, times, resets, phases, initial, half_window, sample_fps):
    if not values:
        return []
    lookahead = max(1, round(sample_fps * 0.18))
    ownership = [camera_ownership_phase({"action_phase": phase}) for phase in phases]
    targets = []
    for index, value in enumerate(values):
        future = index
        for candidate in range(index + 1, min(len(values), index + lookahead + 1)):
            if resets[candidate] or ownership[candidate] != ownership[index]:
                break
            future = candidate
        targets.append(value * 0.92 + values[future] * 0.08)
    output, current, previous_time = [], targets[0] if math.isfinite(targets[0]) else initial, times[0]
    for index, (target, timestamp) in enumerate(zip(targets, times)):
        if resets[index]:
            current = target
        delta = target - current
        if abs(delta) < CAMERA_DEAD_ZONE:
            delta = 0.0
        step = delta * clamp(0.10 + abs(delta) * 0.58, 0.10, 0.32)
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


def phase_camera_targets(records, field, view_size, goal_mode=False):
    """Convert noisy detections into deliberate hold, pan, and payoff camera modes."""
    targets = [record[field] for record in records]
    if not targets:
        return targets
    start = 0
    for index in range(1, len(records) + 1):
        boundary = index == len(records) or records[index]["scene_cut"]
        if not boundary:
            continue
        shot = records[start:index]
        for phase in ("setup", "contact"):
            phase_indexes = [start + offset for offset, record in enumerate(shot) if record["action_phase"] == phase]
            frameable = [idx for idx in phase_indexes if records[idx]["joint_fit"]]
            if frameable:
                bounds = [
                    framing_bounds(records[idx], view_size) if field.endswith("_x")
                    else vertical_framing_bounds(records[idx], view_size)
                    for idx in frameable
                ]
                common_low = max(item[0] for item in bounds)
                common_high = min(item[1] for item in bounds)
                # Hold a tripod-like crop only when one viewport can contain
                # every required subject. A dribble or cross that leaves that
                # shared safe region must remain a deliberate smooth pan.
                if common_low <= common_high:
                    stable = clamp(float(np.median([targets[idx] for idx in frameable])),
                                   common_low, common_high)
                    for idx in phase_indexes:
                        targets[idx] = stable
        # Do not freeze the camera at an estimated payoff time: the ball may
        # still be travelling, or the source camera may still be panning.
        start = index
    return targets


def enforce_joint_framing(camera_x, records, view_width):
    """Stabilize the crop while keeping every frameable player/ball pair visible."""
    half_view = view_width / 2
    frame_edge = min(0.028, view_width * 0.075)
    global_bounds = (half_view, 1.0 - half_view)
    bounds = []
    for record in records:
        if record["ball_x"] is None or record["player_x"] is None:
            bounds.append(global_bounds)
            continue
        joint_left = min(record["ball_x"], record["player_x1"])
        joint_right = max(record["ball_x"], record["player_x2"])
        if joint_right - joint_left + frame_edge * 2 > view_width:
            bounds.append(global_bounds)
            continue
        minimum_center = max(half_view, joint_right + frame_edge - half_view)
        maximum_center = min(1.0 - half_view, joint_left - frame_edge + half_view)
        bounds.append((minimum_center, maximum_center) if minimum_center <= maximum_center else global_bounds)

    output = [clamp(center, lower, upper) for center, (lower, upper) in zip(camera_x, bounds)]
    # Project a symmetric temporal smoother back into the valid framing interval.
    # Looking both backward and forward lets the crop begin a necessary pan early
    # instead of snapping only when a fast pass or shot reaches the frame edge.
    for _ in range(8):
        softened = output[:]
        for index in range(len(output)):
            values = [(camera_x[index], 0.34)]
            if index > 0 and not records[index]["scene_cut"]:
                values.append((output[index - 1], 0.33))
            if index + 1 < len(output) and not records[index + 1]["scene_cut"]:
                values.append((output[index + 1], 0.33))
            desired = weighted_center(values, camera_x[index])
            lower, upper = bounds[index]
            softened[index] = clamp(desired, lower, upper)
        output = softened

    for index in range(1, len(output)):
        if records[index]["scene_cut"] or abs(output[index] - output[index - 1]) >= 0.006:
            continue
        lower, upper = bounds[index]
        if lower <= output[index - 1] <= upper:
            output[index] = output[index - 1]
    # Bound speed and acceleration inside each source shot. Re-projecting after
    # every pass keeps a required player/ball pair visible without frame-by-frame
    # recentering or left-right correction jitter.
    maximum_step = MAX_CAMERA_SPEED / 10.0
    maximum_acceleration = 0.0030
    for _ in range(6):
        previous_velocity = 0.0
        for index in range(1, len(output)):
            if records[index]["scene_cut"]:
                previous_velocity = 0.0
                continue
            lower, upper = bounds[index]
            velocity = clamp(output[index] - output[index - 1], previous_velocity - maximum_acceleration, previous_velocity + maximum_acceleration)
            velocity = clamp(velocity, -maximum_step, maximum_step)
            output[index] = clamp(output[index - 1] + velocity, lower, upper)
            previous_velocity = output[index] - output[index - 1]
        for index in range(len(output) - 2, -1, -1):
            if records[index + 1]["scene_cut"]:
                continue
            lower, upper = bounds[index]
            output[index] = clamp(
                output[index], max(lower, output[index + 1] - maximum_step),
                min(upper, output[index + 1] + maximum_step),
            ) if max(lower, output[index + 1] - maximum_step) <= min(upper, output[index + 1] + maximum_step) else clamp(output[index], lower, upper)
    return output


def create_arrow(path):
    image = np.zeros((188, 160, 4), dtype=np.uint8)
    points = np.array([[58, 18], [102, 18], [102, 112], [136, 112], [80, 176], [24, 112], [58, 112]], np.int32)
    cv2.fillPoly(image, [points + np.array([4, 5])], (0, 0, 0, 150), cv2.LINE_AA)
    cv2.fillPoly(image, [points], (36, 45, 240, 255), cv2.LINE_AA)
    cv2.polylines(image, [points], True, (245, 245, 255, 235), 4, cv2.LINE_AA)
    if not cv2.imwrite(str(path), image):
        raise RuntimeError(f"Could not create player arrow at {path}")


def create_ring(path):
    image = np.zeros((320, 320, 4), dtype=np.uint8)
    # One unmistakable, broadcast-safe marker: large, thick and red only.
    cv2.circle(image, (160, 160), 128, (0, 0, 255, 255), 20, cv2.LINE_AA)
    if not cv2.imwrite(str(path), image):
        raise RuntimeError(f"Could not create player ring at {path}")


def build_keyframes(
    records, media_width, media_height, fallback_x, output_width, window_height,
    window_top, zoom, sample_fps, contact_time, annotation_start, annotation_end, goal_mode,
    event_type,
):
    if not records:
        return [], {"style": "none", "confidence": 0.0, "duration": 0.0}
    times = [record["time"] for record in records]
    resets = [record["scene_cut"] for record in records]
    target_ratio = output_width / max(1, window_height)
    crop_width = min(media_width, media_height * target_ratio) / zoom
    crop_height = min(media_height, media_width / target_ratio) / zoom
    half_x, half_y = crop_width / media_width / 2, crop_height / media_height / 2
    scorer_track_id = select_scorer_track_id(records, contact_time) if goal_mode else None
    decisive_event = event_type in {
        "goal", "disallowed_goal", "shot_on_target", "shot_off_target", "save", "big_chance"
    }
    if scorer_track_id is not None:
        # The decisive-touch identity is known only after the whole scene has
        # been observed. Back-propagate that verified scorer through setup and
        # contact whenever the same track is visible, replacing an early
        # defender selected from one ambiguous ball detection.
        for record in records:
            if (record["action_phase"] not in {"setup", "contact"}
                    or record["time"] < max(0.0, annotation_start - .35)
                    or record["time"] > contact_time + .25):
                continue
            scorer = next((person for person in record.get("players", [])
                if person.get("trackId") == scorer_track_id), None)
            if scorer is None:
                continue
            record.update({
                "player_x": scorer["cx"], "player_y": scorer["cy"],
                "player_top": scorer["y1"], "player_bottom": scorer["y2"],
                "player_x1": scorer["x1"], "player_x2": scorer["x2"],
                "player_track_id": scorer_track_id,
            })
            if record.get("ball_x") is not None:
                left = min(record["ball_x"], scorer["x1"])
                right = max(record["ball_x"], scorer["x2"])
                target_x = record["ball_x"] * .72 + scorer["cx"] * .28
                margin = min(.035, crop_width / media_width * .11)
                half_view = crop_width / media_width / 2
                if right - left + margin * 2 <= crop_width / media_width:
                    target_x = clamp(
                        target_x,
                        right + margin - half_view,
                        left - margin + half_view,
                    )
                record["camera_target_x"] = target_x
                record["camera_target_y"] = weighted_center([
                    (record["ball_y"], 2.8), (scorer["cy"], 2.2)
                ], record["camera_target_y"])
            # When the ball is temporarily missing, retain the last verified
            # action crop. A scorer detection alone must never pull the camera
            # away from the football path.
    camera_x_targets = phase_camera_targets(
        records, "camera_target_x", crop_width / media_width, goal_mode
    )
    camera_y_targets = phase_camera_targets(
        records, "camera_target_y", crop_height / media_height, goal_mode
    )
    # Detector samples are evidence, not render keyframes.  First remove
    # sample-to-sample noise, then project that deliberate path back into the
    # hard player/ball visibility bounds.  The previous implementation
    # calculated this smoothed path and immediately overwrote it with a second
    # solve against the raw detections, which produced visible crop shake.
    smoothed_x_targets = smooth_camera(
        camera_x_targets, times, resets, [record["action_phase"] for record in records],
        fallback_x, half_x, sample_fps
    )
    smoothed_y_targets = smooth_camera(
        camera_y_targets, times, resets, [record["action_phase"] for record in records],
        0.5, half_y, sample_fps
    )
    camera_x = constrained_camera(
        smoothed_x_targets, records, crop_width / media_width,
        max_speed=.22, axis="x",
    )
    camera_y = constrained_camera(
        smoothed_y_targets, records, crop_height / media_height,
        max_speed=.14, axis="y",
    )
    # Only source shot changes may reset the virtual camera. A phase change is
    # a pan from kicker to ball/goal, never an artificial crop jump.
    camera_cuts = [False] * len(records)

    origin_records = [
        record for record in records
        if record["origin_track_id"] is not None and record["time"] <= contact_time + 0.75
    ]
    stable_action_track_id = select_stable_action_track_id(records, annotation_start, annotation_end) if not goal_mode else None
    if scorer_track_id is not None:
        highlight_track_id = scorer_track_id
    elif decisive_event:
        # The annotation-window identity is more relevant than an unrelated
        # possession origin captured many seconds before the decisive action.
        highlight_track_id = stable_action_track_id or (origin_records[0]["origin_track_id"] if origin_records else None)
    else:
        # Never guess a scorer from a generic active-player track.
        # Multi-pass and dribble scenes transfer the ring with locally verified
        # possession instead of pinning it to the first player for the whole
        # scene. A goal/shot remains fixed to its decisive player above.
        highlight_track_id = None
    def highlight_record(record):
        dynamic_track_id = (record.get("player_track_id")
            if not decisive_event and record.get("possession") and record.get("direct_ball") else None)
        marker_track_id = highlight_track_id if decisive_event else dynamic_track_id
        player = next((item for item in record.get("players", []) if item.get("trackId") == marker_track_id), None)
        if player is None:
            return None
        distance = player_ball_distance(player, record)
        confidence = clamp(float(player.get("confidence", 0)) * .42
            + clamp(1 - distance / .16, 0, 1) * .38
            + clamp(float(player.get("trackAge", 0)) / 5, 0, 1) * .20, 0, 1)
        joint_span = max(record["ball_x"], player["x2"]) - min(record["ball_x"], player["x1"]) if record.get("ball_x") is not None else 1
        joint_fit = bool(record.get("ball_x") is not None and joint_span + min(.056, crop_width / media_width * .15) * 2 <= crop_width / media_width)
        return {
            **record,
            "player_x": player["cx"], "player_y": player["cy"], "player_top": player["y1"],
            "player_bottom": player["y2"], "player_x1": player["x1"], "player_x2": player["x2"],
            "player_track_id": player["trackId"], "subject_confidence": confidence,
            "joint_span": joint_span, "joint_fit": joint_fit,
        }

    marker_records = [highlight_record(record) for record in records]
    intro_records = [record for record in marker_records
        if record is not None
        and (not decisive_event or annotation_start <= record["time"] <= annotation_end)
        and record["ball_x"] is not None and record["joint_fit"]]

    keyframes = []
    for index, record in enumerate(records):
        marker_record = marker_records[index] or record
        crop_left = camera_x[index] * media_width - crop_width / 2
        crop_top = camera_y[index] * media_height - crop_height / 2
        player_center_x = (marker_record["player_x"] * media_width - crop_left) / crop_width * output_width if marker_record["player_x"] is not None else -320
        player_center_y = window_top + (marker_record["player_y"] * media_height - crop_top) / crop_height * window_height if marker_record["player_y"] is not None else -320
        player_top_y = window_top + (marker_record["player_top"] * media_height - crop_top) / crop_height * window_height if marker_record["player_top"] is not None else -320
        ball_center_x = (record["ball_x"] * media_width - crop_left) / crop_width * output_width if record["ball_x"] is not None else -320
        ball_center_y = window_top + (record["ball_y"] * media_height - crop_top) / crop_height * window_height if record["ball_y"] is not None else -320
        ball_in_frame = visible_in_crop(record["ball_x"], record["ball_y"], camera_x[index], camera_y[index], half_x * 2, half_y * 2)
        composition_margin = min(0.035, half_x * 2 * 0.11) if record["action_phase"] in {"setup", "contact"} else 0.0
        player_in_frame = (marker_record["player_x"] is not None
            and visible_in_crop(marker_record["player_x1"], marker_record["player_top"], camera_x[index], camera_y[index], half_x * 2, half_y * 2, composition_margin)
            and visible_in_crop(marker_record["player_x2"], marker_record["player_bottom"], camera_x[index], camera_y[index], half_x * 2, half_y * 2, composition_margin))
        outcome_subject = record.get("outcome_subject")
        outcome_subject_in_frame = bool(
            outcome_subject is not None
            and visible_in_crop(outcome_subject["x1"], outcome_subject["y1"], camera_x[index], camera_y[index], half_x * 2, half_y * 2)
            and visible_in_crop(outcome_subject["x2"], outcome_subject["y2"], camera_x[index], camera_y[index], half_x * 2, half_y * 2)
        )
        goal_anchor_x = record.get("goal_focus_x")
        if not isinstance(goal_anchor_x, (int, float)) and record.get("payoff_box") is not None:
            goal_anchor_x = (record["payoff_box"][0] + record["payoff_box"][2]) / 2
        goal_anchor_y = ((record["payoff_box"][1] + record["payoff_box"][3]) / 2
            if record.get("payoff_box") is not None else .56)
        goal_anchor_in_frame = visible_in_crop(
            goal_anchor_x, goal_anchor_y, camera_x[index], camera_y[index], half_x * 2, half_y * 2
        )
        goal_context_in_frame = bool(goal_anchor_in_frame and outcome_subject_in_frame)
        marker_identity_verified = (
            marker_records[index] is not None
            and (not decisive_event or marker_record["player_track_id"] == highlight_track_id)
        )
        marker_time_verified = (
            annotation_start <= record["time"] <= min(annotation_end, contact_time + 0.12)
            and record["action_phase"] in {"setup", "contact"}
        ) if decisive_event else bool(record.get("possession"))
        marker_visible = (
            marker_identity_verified
            and record["ball_x"] is not None
            and marker_record["joint_fit"]
            and marker_record["subject_confidence"] >= 0.52
            and marker_time_verified
            and ball_in_frame and player_in_frame and record["direct_ball"]
        )
        ball_marker_visible = record["direct_ball"] and record["ball_confidence"] >= 0.12
        player_edge_clearance = (min(
            marker_record["player_x1"] - crop_left / media_width,
            (crop_left + crop_width) / media_width - marker_record["player_x2"],
        ) / max(0.000001, crop_width / media_width)) if marker_record["player_x"] is not None else -1.0
        ball_edge_clearance = (min(
            record["ball_x"] - crop_left / media_width,
            (crop_left + crop_width) / media_width - record["ball_x"],
        ) / max(0.000001, crop_width / media_width)) if record["ball_x"] is not None else -1.0
        action_left = min(record["ball_x"], record["player_x1"]) if record["ball_x"] is not None and record["player_x"] is not None else None
        action_right = max(record["ball_x"], record["player_x2"]) if action_left is not None else None
        action_center_offset = (abs((action_left + action_right) / 2 - camera_x[index]) / max(0.000001, half_x)) if action_left is not None else 1.0
        composition_safe = bool(
            record["action_phase"] not in {"setup", "contact"}
            or (active_joint_fit_in_crop(record, camera_x[index], camera_y[index], half_x * 2, half_y * 2)
                and action_center_offset <= 0.55
                and player_edge_clearance >= 0.055)
        )
        keyframes.append({
            "time": round(record["time"], 3), "cameraX": round(camera_x[index], 6), "cameraY": round(camera_y[index], 6),
            "playerCenterX": round(player_center_x, 2), "playerCenterY": round(player_center_y, 2), "playerTopY": round(player_top_y, 2),
            "ballCenterX": round(ball_center_x, 2), "ballCenterY": round(ball_center_y, 2),
            "markerVisible": 1 if marker_visible else 0, "ballMarkerVisible": 1 if ball_marker_visible else 0,
            "ballConfidence": round(record["ball_confidence"], 4), "subjectConfidence": round(marker_record["subject_confidence"], 4), "jointVisible": 1 if record["joint_visible"] else 0,
            # Framing quality follows the currently involved player through a
            # verified handoff. Marker visibility remains tied to the scorer or
            # origin identity above and is never transferred by this metric.
            "jointFit": 1 if active_joint_fit_in_crop(
                record, camera_x[index], camera_y[index], half_x * 2, half_y * 2
            ) else 0, "sceneCut": 1 if record["scene_cut"] else 0,
            "cameraCut": 1 if camera_cuts[index] else 0,
            "directBall": bool(record["direct_ball"]), "ballGuidance": bool(record.get("ball_guidance")), "ballInFrame": bool(ball_in_frame),
            "playerInFrame": bool(player_in_frame), "playerTrackId": marker_record["player_track_id"],
            "playerEdgeClearance": round(player_edge_clearance, 4),
            "ballEdgeClearance": round(ball_edge_clearance, 4),
            "actionCenterOffset": round(action_center_offset, 4),
            "compositionSafe": bool(composition_safe),
            "outcomeSubjectInFrame": bool(outcome_subject_in_frame),
            "goalMouthAnchorInFrame": bool(goal_anchor_in_frame),
            "goalContextInFrame": bool(goal_context_in_frame),
            "cropBox": [crop_left / media_width, crop_top / media_height, (crop_left + crop_width) / media_width, (crop_top + crop_height) / media_height],
            "payoffRegionInFrame": bool(record.get("payoff_box") and all(visible_in_crop(x, y, camera_x[index], camera_y[index], half_x * 2, half_y * 2, -0.000001) for x, y in [(record["payoff_box"][0], record["payoff_box"][1]), (record["payoff_box"][2], record["payoff_box"][3])])),
            "actionPhase": record["action_phase"], "originTrackId": record["origin_track_id"],
            "highlightMode": "decisive_player" if decisive_event else "verified_ball_carrier",
        })
    annotation = {"style": "none", "confidence": 0.0, "duration": 0.0}
    intro = intro_records
    if intro:
        first = intro[0]
        continuity = len(intro) / max(1, len([
            record for record in records if annotation_start <= record["time"] <= annotation_end
        ]))
        confidence = clamp(float(np.median([record["subject_confidence"] for record in intro])) * 0.68 + continuity * 0.24 + clamp(first["ball_confidence"] / 0.45, 0.0, 1.0) * 0.08, 0.0, 1.0)
        index = next(index for index, record in enumerate(records) if record["time"] == first["time"])
        crop_left = camera_x[index] * media_width - crop_width / 2
        crop_top = camera_y[index] * media_height - crop_height / 2
        projected_x = (first["player_x"] * media_width - crop_left) / crop_width * output_width
        center_y = window_top + (first["player_y"] * media_height - crop_top) / crop_height * window_height
        top_y = window_top + (first["player_top"] * media_height - crop_top) / crop_height * window_height
        style = "arrow" if confidence >= 0.58 else "none"
        if style != "none":
            asset = ASSETS[style]
            x = projected_x - asset["anchor_x"]
            y = top_y - asset["anchor_y"]
            if -asset["width"] * 0.25 <= x <= output_width - asset["width"] * 0.75 and window_top - asset["height"] * 0.25 <= y <= window_top + window_height - asset["height"] * 0.75:
                annotation = {
                    "style": style, "confidence": round(confidence, 4), "duration": 0.50,
                    "cueTime": round(first["time"], 3),
                    "trackDuration": round(min(2.4, max(0.6, annotation_end - first["time"])), 3),
                    "x": round(clamp(x, -asset["width"] * 0.15, output_width - asset["width"] * 0.85), 2),
                    "y": round(clamp(y, window_top - asset["height"] * 0.10, window_top + window_height - asset["height"] * 0.90), 2),
                    "sourceX": round(first["player_x"], 6),
                    "sourceYTop": round(first["player_top"], 6),
                    "sourceYCenter": round(first["player_y"], 6),
                    "trackId": highlight_track_id,
                }
    return keyframes, annotation
def track_moment(person_model, ball_model, capture, moment, media_width, media_height, source_fps, args):
    start, end = float(moment["startTime"]), float(moment["endTime"])
    duration = end - start
    contact_time = brief_local_time(moment, "contactTime", duration * 0.34)
    flight_time = max(contact_time, brief_local_time(moment, "flightStartTime", duration * 0.38))
    handoff_time = max(flight_time, brief_local_time(moment, "handoffTime", duration * 0.50))
    payoff_time = max(handoff_time, brief_local_time(moment, "payoffStartTime", duration * 0.68))
    recommended_x = next((item.get("x") for item in moment.get("recommendedCrop", [])
        if isinstance(item, dict) and isinstance(item.get("x"), (int, float))), 0.5)
    semantic_x = float(moment.get("focusX", recommended_x))
    # A semantic crop is deliberately coarse. Dampen it toward broadcast center
    # until the local football path establishes a trustworthy camera position.
    attack_direction = (moment.get("trackingBrief") or {}).get("attackDirection")
    verified_goal_route = (moment.get("eventType") in {"goal", "disallowed_goal"}
        and attack_direction in {"left", "right"})
    fallback_x = clamp(semantic_x if verified_goal_route else semantic_x * .35 + .5 * .65, 0.0, 1.0)
    target_ratio = args.output_width / max(1, args.window_height)
    view_width = min(media_width, media_height * target_ratio) / args.zoom / media_width
    # Build reusable observations first, then associate the football with future
    # context. No semantic hypothesis can turn a predicted point into a detection.
    observed_frames = []
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, math.ceil(start * source_fps)))
    previous_sample_key, previous_frame = None, max(0, math.ceil(start * source_fps)) - 1
    detector = SlicedBallDetector(ball_model, args.ball_image_size, args.ball_confidence, args.device)
    detection_hint = None
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        number = max(0, int(capture.get(cv2.CAP_PROP_POS_FRAMES)) - 1)
        timestamp = number / source_fps
        if timestamp >= end:
            break
        elapsed = timestamp - start
        sample_rate = adaptive_sample_rate(elapsed, duration, contact_time, payoff_time, args.sample_fps, args.coarse_sample_fps)
        sample_key = (sample_rate, math.floor(timestamp * sample_rate + .000001))
        if sample_key == previous_sample_key:
            continue
        previous_sample_key = sample_key
        observations = args.observations.get(number)
        if observations is None:
            detector.frames = math.floor(timestamp * args.sample_fps + .000001)
            observations = frame_detections(person_model, detector, frame, args.image_size,
                args.ball_image_size, args.confidence, args.ball_confidence, detection_hint, args.device)
            args.observations.put(number, observations)
        cut = any(previous_frame < boundary <= number for boundary in (args.shot_frames or []))
        observed_frames.append({"frame": number, "time": timestamp, "people": observations[0], "balls": observations[1], "cut": cut})
        if cut:
            detection_hint = None
        trusted_hints = [ball for ball in observations[1]
            if ball.get("confidence", 0) >= .12 and ball.get("pitchSupport", 0) >= .08]
        if trusted_hints:
            hint = max(trusted_hints, key=lambda ball: ball["confidence"] + ball.get("pitchSupport", 0) * .35)
            detection_hint = np.asarray([hint["cx"], hint["cy"]], dtype=float)
        previous_frame = number
        if len(observed_frames) % 10 == 1:
            print("TRACK_PROGRESS " + json.dumps({"completed": args.scene_index, "total": args.scene_total,
                "pass": "detect", "sceneId": moment["id"], "sceneSeconds": round(timestamp-start, 1), "sceneDuration": round(end-start, 1),
                "cacheHits": args.observations.hits, "newFrames": args.observations.misses}), flush=True)

    tracking_brief = moment.get("trackingBrief") or {}
    goal_focus_value = tracking_brief.get("goalFocusX")
    goal_focus_x = clamp(float(goal_focus_value), 0.0, 1.0) if isinstance(goal_focus_value, (int, float)) else None
    payoff_target = (tracking_brief.get("payoffEvidence") or {}).get("targetBox")
    goal_focus_y = ((float(payoff_target[1]) + float(payoff_target[3])) / 2
        if isinstance(payoff_target, list) and len(payoff_target) == 4
        and all(isinstance(value, (int, float)) for value in payoff_target) else None)
    # Constrain candidates before association so alternatives remain available.
    for observation in observed_frames:
        observation["payoff_box"] = observed_payoff_box(moment, observation["time"])
        observation["airborne"] = (moment.get("eventType") in {"goal", "save", "shot_on_target", "big_chance"}
            and flight_time <= observation["time"] - start <= payoff_time)
        observation["goal_focus_x"] = goal_focus_x
        observation["goal_payoff"] = bool(moment.get("eventType") == "goal" and observation["time"] - start >= payoff_time)
    sampled_frame_numbers = {observation["frame"] for observation in observed_frames}
    ball_path = choose_trajectory(
        observed_frames, view_width, args.output_width, initial_focus_x=fallback_x,
        attack_direction=attack_direction,
        contact_time=start + contact_time,
        goal_focus_x=goal_focus_x,
        goal_focus_y=goal_focus_y,
    )
    if moment.get("eventType") in {"goal", "disallowed_goal"} and payoff_target is not None:
        corrected_x, corrected_box, correction_reason = reconcile_goal_destination(
            observed_frames, ball_path, start, contact_time, payoff_time, goal_focus_x, payoff_target
        )
        semantic_route_conflict = correction_reason is not None
    else:
        semantic_route_conflict = False
    replay_mode = moment.get("isReplay") is True or moment.get("storyPhase") == "replay"
    gap_guidance = trajectory_camera_guidance(
        observed_frames, ball_path,
        # A football may be only a few source pixels and disappear through
        # compression or bodies for over a second. Interpolate the camera
        # between real same-shot endpoints; phase verification still records
        # these samples as guidance rather than direct detections.
        maximum_gap=1.8 if replay_mode else 1.6,
        edge_hold=.65 if replay_mode else .55,
        opening_hold=3.0,
    )
    annotation_start = brief_local_time(moment, "annotationStartTime", duration * 0.08)
    annotation_end = max(annotation_start, brief_local_time(moment, "annotationEndTime", min(duration, contact_time + 0.65)))
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(start * source_fps)))
    records = []
    last_ball = last_ball_time = last_direct_ball_time = None
    ball_velocity = (0.0, 0.0)
    tracker = MotionPersonTracker(args.sample_fps, args.tracker, args.camera_motion)
    ball_detector = SlicedBallDetector(ball_model, args.ball_image_size, args.ball_confidence, args.device)
    subject_id = pending_id = None
    pending_count = 0
    origin_id = origin_candidate_id = None
    origin_candidate_hits = 0
    previous_histogram = None
    direct_ball_frames = people_frames = sampled_frames = 0
    current_direct_gap = maximum_direct_gap = 0.0
    identity_switches = 0
    previous_subject_id = None
    departed_samples = 0
    goal_mode = moment.get("eventType") in {"goal", "disallowed_goal"}
    allowed_ball_gap = GOAL_BALL_GAP_SECONDS if goal_mode else MAX_BALL_GAP_SECONDS
    last_sample_frame = max(0, int(start * source_fps)) - 1
    while True:
        success, frame = capture.read()
        if not success:
            break
        frame_number = max(0, int(capture.get(cv2.CAP_PROP_POS_FRAMES)) - 1)
        timestamp = frame_number / source_fps
        if timestamp >= end:
            break
        if timestamp + 0.0001 < start or frame_number not in sampled_frame_numbers:
            continue
        sample_tick = math.floor(timestamp * args.sample_fps + 0.000001)
        sampled_frames += 1
        thumbnail = cv2.cvtColor(cv2.resize(frame, (96, 54), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2HSV)
        histogram = cv2.calcHist([thumbnail], [0, 1], None, [24, 16], [0, 180, 0, 256])
        cv2.normalize(histogram, histogram)
        scene_cut = previous_histogram is not None and cv2.compareHist(previous_histogram, histogram, cv2.HISTCMP_BHATTACHARYYA) >= 0.46
        if getattr(args, "shot_frames", None) is not None:
            scene_cut = bool(records) and any(last_sample_frame < cut <= frame_number for cut in args.shot_frames)
        last_sample_frame = frame_number
        previous_histogram = histogram
        if scene_cut:
            last_ball = last_ball_time = last_direct_ball_time = None
            ball_velocity = (0.0, 0.0)
            subject_id = pending_id = None
            pending_count = 0
            departed_samples = 0
            origin_id = origin_candidate_id = None
            origin_candidate_hits = 0
            tracker.reset()
        observations = args.observations.get(frame_number)
        if observations is None:
            # Detection is independent of the edit plan and previous guessed ball.
            # A source-global cadence makes overlapping scene requests reusable.
            ball_detector.frames = sample_tick
            people, balls = frame_detections(
                person_model, ball_detector, frame, args.image_size, args.ball_image_size,
                args.confidence, args.ball_confidence, None, args.device,
            )
            args.observations.put(frame_number, [people, balls])
        else:
            people, balls = observations
        if sampled_frames % 10 == 1:
            print("TRACK_PROGRESS " + json.dumps({"completed": args.scene_index, "total": args.scene_total,
                  "pass": "camera", "sceneId": moment["id"], "sceneSeconds": round(timestamp - start, 1),
                  "sceneDuration": round(duration, 1), "cacheHits": args.observations.hits,
                  "newFrames": args.observations.misses}), flush=True)
        # Keep low-confidence raw people for goalmouth context. BoT-SORT may
        # intentionally withhold a small goalkeeper detection until it has
        # enough identity evidence; framing the visible goal-line player does
        # not require asserting that identity.
        detected_people = people
        people = tracker.update(people, frame, timestamp)
        people_frames += 1 if people else 0
        # Offline interpolation uses both observed endpoints. Do not extrapolate
        # a missed airborne ball toward the edge of the pitch.
        predicted = gap_guidance.get(frame_number)
        for candidate in balls:
            candidate["output_diameter"] = max(candidate["x2"] - candidate["x1"], candidate["y2"] - candidate["y1"]) / view_width * args.output_width
            candidate["nearest_player_distance"] = min(
                (point_distance((person["cx"], person["y2"]), (candidate["cx"], candidate["cy"]), 0.52) for person in people),
                default=1.0,
            )
            on_pitch_people = [person for person in people if person.get("pitchSupport", 0.0) >= 0.08]
            candidate["nearestOnPitchPlayerDistance"] = min(
                (point_distance((person["cx"], person["y2"]), (candidate["cx"], candidate["cy"]), 0.52) for person in on_pitch_people),
                default=1.0,
            )
        plausible_balls = [candidate for candidate in balls if MIN_VISIBLE_BALL_DIAMETER <= candidate["output_diameter"] <= MAX_VISIBLE_BALL_DIAMETER]
        payoff_evidence = moment.get("trackingBrief", {}).get("payoffEvidence") or {}
        planned_payoff = observed_payoff_box(moment, payoff_evidence.get("startTime", -1))
        verified_flight = bool(goal_mode and planned_payoff is not None and timestamp - start >= flight_time
                               and timestamp < payoff_evidence["startTime"])
        payoff_box = observed_payoff_box(moment, timestamp)
        if payoff_box is not None:
            def in_payoff(x, y):
                return payoff_box[0] <= x <= payoff_box[2] and payoff_box[1] <= y <= payoff_box[3]
            plausible_balls = [candidate for candidate in plausible_balls if in_payoff(candidate["cx"], candidate["cy"])]
            for candidate in plausible_balls:
                candidate["payoffSupported"] = True
            if predicted is not None and not in_payoff(*predicted):
                predicted = None
        # Reacquire across the whole pitch after a miss; never permanently stop
        # searching a goal scene after the first occlusion.
        path_ball = ball_path.get(frame_number)
        candidate_ball = next((candidate for candidate in plausible_balls if path_ball is not None
            and abs(candidate["cx"] - path_ball["cx"]) < .000001 and abs(candidate["cy"] - path_ball["cy"]) < .000001), None)
        detected = candidate_ball if candidate_ball is not None and float(candidate_ball["confidence"]) >= 0.12 else None
        ball_pixel_diameter = detected["output_diameter"] if detected is not None else 0.0
        direct_ball = detected is not None
        ball_guidance = direct_ball
        ball_confidence = 0.0
        if detected is not None:
            direct_ball_frames += 1 if direct_ball else 0
            measured = (detected["cx"], detected["cy"])
            if last_ball is not None and last_ball_time is not None:
                gap = max(0.001, timestamp - last_ball_time)
                measured_velocity = ((measured[0] - last_ball[0]) / gap, (measured[1] - last_ball[1]) / gap)
                ball_velocity = (
                    clamp(ball_velocity[0] * 0.60 + measured_velocity[0] * 0.40, -1.1, 1.1),
                    clamp(ball_velocity[1] * 0.60 + measured_velocity[1] * 0.40, -1.1, 1.1),
                )
            last_ball, last_ball_time = measured, timestamp
            if direct_ball:
                last_direct_ball_time = timestamp
            ball_confidence = float(detected["confidence"])
        elif predicted is not None:
            last_ball, last_ball_time = predicted, timestamp
            ball_guidance = True
            # Camera guidance is bounded by real trajectory endpoints; keep it
            # distinct from a direct detection while smoothly bridging occlusion.
            velocity_decay = 0.62 if goal_mode else 0.76
            ball_velocity = (ball_velocity[0] * velocity_decay, ball_velocity[1] * velocity_decay)
            distance_from_direct = timestamp - last_direct_ball_time if last_direct_ball_time is not None else allowed_ball_gap
            ball_confidence = max(0.04, 0.14 * (1 - min(1, distance_from_direct / max(.001, allowed_ball_gap))))
        else:
            last_ball, ball_velocity = None, (0.0, 0.0)
        elapsed = timestamp - start
        phase = action_phase(elapsed, contact_time, flight_time, payoff_time)
        handoff_activation = min(handoff_time, contact_time + 0.45)
        scorer_handoff = goal_mode and elapsed >= max(0.0, contact_time - 0.90)
        allow_handoff = scorer_handoff or (phase in {"flight", "payoff"} and elapsed >= handoff_activation)
        incumbent = next((person for person in people
            if person.get("trackId") == subject_id and person.get("pitchSupport", 0.0) >= 0.08), None)
        departed = bool(direct_ball and incumbent is not None and last_ball is not None
                        and point_distance((incumbent["cx"], incumbent["y2"]), last_ball, 0.52) > 0.13)
        departed_samples = departed_samples + 1 if departed else 0
        # Local observed flight overrides a late semantic timestamp. Two samples
        # prevent one noisy detection from transferring player ownership.
        allow_handoff = allow_handoff or departed_samples >= 2
        if departed_samples >= 2 and phase in {"setup", "contact"}:
            phase = "flight"
        if last_ball is None:
            active = next((person for person in people
                if person.get("trackId") == subject_id and person.get("pitchSupport", 0.0) >= 0.08), None)
            if subject_id is None:
                active, pending_id, pending_count = None, None, 0
        else:
            subject_before_association = subject_id
            active, subject_id, pending_id, pending_count = choose_locked_player(
                people, last_ball, subject_id, pending_id, pending_count, view_width, allow_handoff,
            )
            if (not allow_handoff and subject_before_association is not None
                    and subject_id is not None and subject_id != subject_before_association):
                # A stronger observed player-and-ball pair corrected an early
                # false lock. Do not let the stale origin lock immediately
                # overwrite that correction below.
                origin_id = None
                origin_candidate_id = subject_id
                origin_candidate_hits = 0
        if direct_ball and active is not None and elapsed <= contact_time + 0.75:
            origin_gap = point_distance((active["cx"], active["y2"]), last_ball, 0.52)
            if origin_gap <= MAX_POSSESSION_DISTANCE:
                if active["trackId"] == origin_candidate_id:
                    origin_candidate_hits += 1
                else:
                    origin_candidate_id, origin_candidate_hits = active["trackId"], 1
                if origin_candidate_hits >= 2:
                    origin_id = origin_candidate_id
        if origin_id is not None and not allow_handoff:
            origin_player = next((person for person in people
                if person.get("trackId") == origin_id and person.get("pitchSupport", 0.0) >= 0.08), None)
            if origin_player is not None:
                active, subject_id = origin_player, origin_id
        if previous_subject_id is not None and subject_id is not None and subject_id != previous_subject_id:
            identity_switches += 1
        if subject_id is not None:
            previous_subject_id = subject_id
        if active is not None:
            proximity = point_distance((active["cx"], active["y2"]), last_ball) if last_ball is not None else 0.5
            proximity_score = clamp(1.0 - proximity / 0.20, 0.0, 1.0)
            maturity = clamp(active.get("trackAge", 1) / 5.0, 0.0, 1.0)
            ball_quality = clamp(ball_confidence / 0.45, 0.0, 1.0) if direct_ball else clamp(ball_confidence / 0.20, 0.0, 0.55)
            subject_confidence = clamp(active["confidence"] * 0.30 + proximity_score * 0.28 + maturity * 0.22 + ball_quality * 0.20, 0.0, 1.0)
        else:
            subject_confidence = 0.0
        planned_goal_x = ((planned_payoff[0] + planned_payoff[2]) / 2
            if planned_payoff is not None else goal_focus_x)
        ball_near_goal = bool(
            last_ball is not None and isinstance(planned_goal_x, (int, float))
            and abs(last_ball[0] - planned_goal_x) <= max(.10, view_width * .42)
        )
        # The goalmouth is a destination, not an immediate camera target. The
        # football owns flight until it visibly enters the goal-side handoff
        # corridor (or the verified payoff begins). This prevents a pre-emptive
        # pan that leaves only the kicker or empty grass in portrait view.
        goal_handoff_ready = bool(
            goal_mode and planned_payoff is not None and (
                payoff_box is not None
                or phase == "payoff"
                or (semantic_route_conflict and phase == "flight")
                or (phase == "flight" and ball_near_goal)
                or (phase == "flight" and last_ball is None
                    and elapsed >= max(contact_time, payoff_time - .45))
            )
        )
        outcome_box = payoff_box or (planned_payoff if goal_handoff_ready else None)
        outcome_subject = goal_outcome_subject(
            detected_people, outcome_box, goal_focus_x, last_ball
        ) if goal_mode and phase in {"flight", "payoff"} else None
        continuity_x = records[-1]["camera_target_x"] if records and not scene_cut else fallback_x
        # A provisional nearest-player detection is useful for association but
        # must not steer the virtual camera.  Only a sustained track identity
        # may widen the crop away from the verified ball path; otherwise one
        # foreground defender can pull alternating samples left and right.
        camera_ball_distance = (point_distance((active["cx"], active["y2"]), last_ball, 0.85)
                                if active is not None and last_ball is not None else 1.0)
        camera_active = active if (
            active is not None and subject_id is not None and last_ball is not None
            and active.get("trackId") == subject_id and active.get("pitchSupport", 0.0) >= 0.08
            and camera_ball_distance <= .18
        ) else None
        target_x, target_y, spread = action_target(
            people, last_ball, camera_active, ball_velocity, continuity_x, view_width, goal_mode, phase
        )
        if (verified_goal_route and isinstance(goal_focus_x, (int, float))
                and elapsed >= max(0.0, contact_time - 2.5)):
            # Compose the approaching carrier and the visible goal together,
            # then hand ownership to the goal after contact. This creates one
            # deliberate pan instead of a last-frame snap behind a fast shot.
            route_progress = clamp((elapsed - (contact_time - 2.5)) / 3.15, 0.0, 1.0)
            goal_weight = .42 * route_progress if elapsed < contact_time else min(1.0, .42 + (elapsed - contact_time) / .72)
            target_x = target_x * (1.0 - goal_weight) + goal_focus_x * goal_weight
        if (verified_goal_route and phase == "setup" and elapsed <= 1.6
                and (last_ball is None or goal_focus_y is None
                    or abs(last_ball[1] - goal_focus_y) > .14)):
            # On opening samples, a route-inconsistent boot must not pull the
            # portrait crop away from Gemini's verified attack-side framing.
            # This is a one-sided safety bound, not a synthetic ball location:
            # a stronger observed trajectory can still lead farther forward.
            opening_anchor_x = (semantic_x * .65 + goal_focus_x * .35
                if isinstance(goal_focus_x, (int, float)) else semantic_x)
            target_x = (max(target_x, opening_anchor_x) if attack_direction == "right"
                else min(target_x, opening_anchor_x))
        if goal_mode and phase in {"flight", "payoff"} and outcome_box is not None:
            # A shot changes camera ownership after contact. Lead the observed
            # ball toward a verified goal-side player and goalmouth, then hold
            # that outcome context instead of following a guessed point into
            # empty grass.
            routed_ball = None if semantic_route_conflict else last_ball
            target_x, target_y = goal_outcome_target(
                outcome_box, goal_focus_x, outcome_subject, routed_ball, phase, target_x
            )
            context_points = [goal_focus_x]
            if outcome_subject is not None:
                context_points.extend([outcome_subject["x1"], outcome_subject["x2"]])
            if last_ball is not None and not semantic_route_conflict:
                context_points.append(last_ball[0])
            context_points = [value for value in context_points if isinstance(value, (int, float))]
            if context_points:
                spread = max(spread, max(context_points) - min(context_points))
        elif phase in {"flight", "payoff"} and last_ball is not None:
            target_x = flight_target(last_ball[0], camera_active, ball_velocity[0], view_width, target_x)
        elif phase in {"flight", "payoff"} and records:
            # With no ball or verified destination, an old player identity is
            # not a valid new camera target. Preserve the last action position.
            target_x = records[-1]["camera_target_x"]
            target_y = records[-1]["camera_target_y"]
        resolved_goal_hold = bool(
            goal_mode
            and outcome_box is None
            and last_ball is None
            and records
            and timestamp - start >= (end - start) * 0.55
        )
        if resolved_goal_hold:
            target_x = records[-1]["camera_target_x"]
            target_y = records[-1]["camera_target_y"]
            spread = records[-1]["action_spread"]
        if payoff_box is not None and not goal_mode:
            target_x = (payoff_box[0] + payoff_box[2]) / 2
            target_y = (payoff_box[1] + payoff_box[3]) / 2
        elif verified_flight and last_ball is None:
            target_y = (planned_payoff[1] + planned_payoff[3]) / 2
            target_x = (planned_payoff[0] + planned_payoff[2]) / 2
        possessing = bool(direct_ball and active is not None and proximity <= MAX_POSSESSION_DISTANCE)
        tracked_ball = last_ball is not None and ball_confidence >= 0.04
        active_ball_distance = (point_distance((active["cx"], active["y2"]), last_ball, 0.85)
                                if active is not None and last_ball is not None else 1.0)
        active_ball_linked = bool(active is not None and active.get("pitchSupport", 0.0) >= 0.08
                                  and active_ball_distance <= .16)
        joint_visible = tracked_ball and active_ball_linked
        joint_span = max(last_ball[0], active["x2"]) - min(last_ball[0], active["x1"]) if joint_visible else 1.0
        joint_margin = min(0.056, view_width * 0.15)
        joint_fit = bool(joint_visible and joint_span + joint_margin * 2 <= view_width)
        sample_gap = max(0.001, elapsed - records[-1]["time"]) if records else 1.0 / args.sample_fps
        current_direct_gap = 0.0 if direct_ball else current_direct_gap + sample_gap
        maximum_direct_gap = max(maximum_direct_gap, current_direct_gap)
        # Camera ownership follows observed possession rather than one semantic
        # contact timestamp. This handles multi-pass buildups: linked carrier,
        # ball in flight, then the verified receiver, without chasing a stale
        # player identity or leading into the next action early.
        camera_owner = "carrier" if joint_visible else (
            "hold" if phase in {"setup", "contact"}
            else ("ball" if tracked_ball else ("payoff" if phase == "payoff" else "hold"))
        )
        records.append({
            "players": people,
            "time": timestamp - start, "camera_target_x": target_x, "camera_target_y": target_y, "action_spread": spread,
            "player_x": camera_active["cx"] if camera_active is not None else None, "player_y": camera_active["cy"] if camera_active is not None else None,
            "player_top": camera_active["y1"] if camera_active is not None else None, "player_track_id": camera_active.get("trackId") if camera_active is not None else None,
            "player_bottom": camera_active["y2"] if camera_active is not None else None,
            "player_x1": camera_active["x1"] if camera_active is not None else None, "player_x2": camera_active["x2"] if camera_active is not None else None,
            "ball_x": last_ball[0] if last_ball is not None else None, "ball_y": last_ball[1] if last_ball is not None else None,
            "direct_ball": direct_ball, "ball_guidance": ball_guidance, "joint_visible": joint_visible, "joint_fit": joint_fit, "joint_span": joint_span,
            "possession": possessing, "ball_pixel_diameter": ball_pixel_diameter,
            "subject_confidence": subject_confidence, "scene_cut": scene_cut, "ball_confidence": ball_confidence,
            "subject_recently_ball_linked": bool(
                active_ball_linked and last_direct_ball_time is not None
                and timestamp - last_direct_ball_time <= .65
            ),
            "pitch_ball": bool(direct_ball and detected.get("pitchSupport", 0.0) >= 0.08) if detected is not None else False,
            "origin_track_id": origin_id, "action_phase": phase, "camera_owner": camera_owner,
            "payoff_box": payoff_box,
            "goal_focus_x": goal_focus_x,
            "outcome_subject": outcome_subject,
        })
    scene_zoom = adaptive_scene_zoom(
        records, media_width, media_height, args.output_width, args.window_height
    )
    keyframes, annotation = build_keyframes(
        records, media_width, media_height, fallback_x, args.output_width, args.window_height,
        args.window_top, scene_zoom, args.sample_fps, contact_time, annotation_start, annotation_end, goal_mode,
        str(moment.get("eventType") or "normal_play"),
    )
    denominator = max(1, sampled_frames)
    camera_positions = [frame["cameraX"] for frame in keyframes]
    camera_steps = [
        abs(camera_positions[index] - camera_positions[index - 1])
        for index in range(1, len(camera_positions)) if not (keyframes[index]["sceneCut"] or keyframes[index].get("cameraCut"))
    ]
    camera_velocities = [
        (index, camera_positions[index] - camera_positions[index - 1])
        for index in range(1, len(camera_positions)) if not (keyframes[index]["sceneCut"] or keyframes[index].get("cameraCut"))
    ]
    camera_jerks = [
        abs(camera_velocities[index][1] - camera_velocities[index - 1][1])
        for index in range(1, len(camera_velocities))
        if camera_velocities[index][0] == camera_velocities[index - 1][0] + 1
    ]
    spreads = [record["action_spread"] for record in records if record["action_spread"] > 0]
    spread_p90 = float(np.percentile(spreads, 90)) if spreads else 0.0
    subject_frames = sum(record["subject_confidence"] >= 0.48 for record in records)
    joint_frames = sum(record["joint_visible"] for record in records)
    joint_fit_frames = sum(frame["jointFit"] for frame in keyframes)
    possession_frames = sum(record["possession"] for record in records)
    pitch_ball_frames = sum(record["pitch_ball"] for record in records)
    origin_lock_frames = sum(record["origin_track_id"] is not None for record in records)
    highlight_track_id = annotation.get("trackId")
    highlight_identity_frames = sum(
        record["possession"] and record["player_track_id"] == highlight_track_id for record in records
    ) if highlight_track_id is not None else 0
    phase_evidence = phase_quality(keyframes, contact_time)
    payoff_keyframes = [frame for frame in keyframes if frame["actionPhase"] == "payoff"]
    # After a shot leaves the kicker, the goal payoff is the continued verified
    # ball trajectory and goal-side camera hold; requiring another nearby player
    # would reject the exact kick-to-goal edit the tracker is designed to make.
    goal_outcome_context_frames = sum(frame.get("goalContextInFrame", False) for frame in payoff_keyframes)
    goal_payoff_frames = sum(
        frame.get("goalContextInFrame", False)
        or (
            frame.get("outcomeSubjectInFrame", False)
            and frame["ballInFrame"]
            and (frame["directBall"] or (replay_mode and frame.get("ballGuidance", False)))
        )
        for frame in payoff_keyframes
    )
    setup_contact_records = [record for record in records if record["action_phase"] in {"setup", "contact"}]
    flight_records = [record for record in records if record["action_phase"] == "flight"]
    goal_origin_frames = sum(frame["jointFit"] and frame["directBall"]
        for frame in keyframes if frame["actionPhase"] in {"setup", "contact"})
    goal_flight_frames = sum(
        frame["ballInFrame"] and (frame["directBall"] or frame.get("ballGuidance", False))
        for frame in keyframes if frame["actionPhase"] == "flight"
    )
    goal_origin_coverage = goal_origin_frames / max(1, len(setup_contact_records))
    goal_flight_coverage = goal_flight_frames / max(1, len(flight_records))
    action_keyframes = [frame for frame in keyframes if frame["actionPhase"] in {"setup", "contact", "flight"}]
    setup_contact_keyframes = [frame for frame in keyframes if frame["actionPhase"] in {"setup", "contact"}]
    central_composition_coverage = sum(
        frame.get("compositionSafe", False) for frame in setup_contact_keyframes
    ) / max(1, len(setup_contact_keyframes))
    action_ball_framing_coverage = sum(
        frame["ballInFrame"] and (frame["directBall"] or frame.get("ballGuidance", False))
        for frame in action_keyframes
    ) / max(1, len(action_keyframes))
    # A semantically verified replay may begin on the broadcast cut into the
    # action and therefore lose one setup observation. Keep live goals at the
    # stricter origin gate; the replay still has to pass contact, flight and
    # payoff independently.
    minimum_origin_coverage = 0.45 if moment.get("isReplay") else 0.50
    goal_action_complete = bool(
        not goal_mode or (
            phase_evidence["contact"]["directJointCoverage"] >= 0.35
            and goal_origin_coverage >= minimum_origin_coverage
            and (not flight_records or goal_flight_coverage >= 0.35)
            and goal_payoff_frames / max(1, len(payoff_keyframes)) >= 0.50
        )
    )
    visible_ball_sizes = [record["ball_pixel_diameter"] for record in records if record["direct_ball"]]
    # Detectors commonly need two or three frames after a broadcast cut. Treat
    # the first sustained 3-of-5 lock inside the opening second as acquisition;
    # do not fail an otherwise clean action because frame zero was undecodable.
    opening_candidates = [frame for frame in keyframes if frame["time"] <= 1.05]
    opening_joint_visible = any(
        sum(frame["directBall"] and frame["jointFit"] for frame in opening_candidates[index:index + 5]) >= 3
        for index in range(max(0, len(opening_candidates) - 4))
    )
    player_only_allowed = moment.get("eventType") == "celebration" or moment.get("storyPhase") == "reaction" or moment.get("role") == "reaction"
    requires_joint_framing = not player_only_allowed
    joint_fit_coverage = joint_fit_frames / denominator
    return {
        "keyframes": keyframes, "annotation": annotation, "layoutMode": "action", "zoom": scene_zoom,
        "fullBleedRepairSuggested": bool(spread_p90 > view_width * 0.82 or (
            requires_joint_framing and (not opening_joint_visible or joint_fit_coverage < 0.70
                or central_composition_coverage < 0.80)
        )),
        "requiresJointFraming": requires_joint_framing, "openingJointVisible": opening_joint_visible,
        "actionSpreadP90": round(spread_p90, 4), "sampledFrames": sampled_frames,
        "ballDetectionCoverage": round(direct_ball_frames / denominator, 4),
        "playerDetectionCoverage": round(people_frames / denominator, 4),
        "jointVisibilityCoverage": round(joint_frames / denominator, 4),
        "jointFitCoverage": round(joint_fit_coverage, 4),
        "subjectLockCoverage": round(subject_frames / denominator, 4),
        "highlightCoverage": round(annotation["duration"] / max(0.001, end - start), 4),
        "maxDirectBallGap": round(maximum_direct_gap, 4),
        "possessionCoverage": round(possession_frames / denominator, 4),
        "pitchBallCoverage": round(pitch_ball_frames / denominator, 4),
        "originLockCoverage": round(origin_lock_frames / denominator, 4),
        "identitySwitches": identity_switches,
        "highlightIdentityCoverage": round(highlight_identity_frames / denominator, 4),
        "goalPayoffCoverage": round(goal_payoff_frames / max(1, len(payoff_keyframes)), 4) if goal_mode else 1.0,
        "goalOutcomeContextCoverage": round(goal_outcome_context_frames / max(1, len(payoff_keyframes)), 4) if goal_mode else 1.0,
        "phaseEvidence": phase_evidence,
        "goalOriginCoverage": round(goal_origin_coverage, 4) if goal_mode else 1.0,
        "goalFlightCoverage": round(goal_flight_coverage, 4) if goal_mode else 1.0,
        "actionBallFramingCoverage": round(action_ball_framing_coverage, 4),
        "centralCompositionCoverage": round(central_composition_coverage, 4),
        "minimumPlayerEdgeClearance": round(min(
            (frame.get("playerEdgeClearance", -1) for frame in setup_contact_keyframes), default=-1
        ), 4),
        "goalActionComplete": goal_action_complete,
        "visibleBallPixelMedian": round(float(np.median(visible_ball_sizes)), 2) if visible_ball_sizes else 0.0,
        "cameraMaxStep": round(max(camera_steps), 4) if camera_steps else 0.0,
        "cameraStepP95": round(float(np.percentile(camera_steps, 95)), 4) if camera_steps else 0.0,
        "cameraJerkP95": round(float(np.percentile(camera_jerks, 95)), 4) if camera_jerks else 0.0,
        "trackingBrief": moment.get("trackingBrief", {}),
        "sourceStartTime": start, "sourceEndTime": end,
        "detector": "football-yolo+supervision-slicer", "personTracker": args.tracker + "-" + args.camera_motion,
        "slicedFrames": detector.sliced_frames + ball_detector.sliced_frames,
        "sourceRecords": records,
        "directBallInFrameCoverage": round(sum(frame["directBall"] and frame["ballInFrame"] for frame in keyframes) / denominator, 4),
    }


def main():
    args = parse_args()
    with open(args.moments, "r", encoding="utf-8") as handle:
        moments = json.load(handle).get("moments", [])
    if args.moment_id:
        moments = [moment for moment in moments if moment.get("id") == args.moment_id]
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
    import torch
    args.device = ("0" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device
    # Two scene workers run concurrently on CPU. Giving each detector every
    # logical core oversubscribes this machine and makes both workers slower.
    torch.set_num_threads(max(1, min(3, (os.cpu_count() or 4) // 4)))
    cv2.setNumThreads(1)
    output_path = Path(args.output)
    cache_dir = Path(args.cache_dir) if args.cache_dir else output_path.parent / "cache"
    detection_signature = {"version": 5, "source": content_fingerprint(args.source),
        "personModel": fingerprint(args.model), "ballModel": fingerprint(args.ball_model),
        "imageSize": args.image_size, "ballImageSize": args.ball_image_size,
        "confidence": args.confidence, "ballConfidence": args.ball_confidence,
        "sampleFps": args.sample_fps, "coarseSampleFps": args.coarse_sample_fps, "device": args.device}
    signature = {"detection": detection_signature, "version": 80, "associationVersion": 27, "tacticalSubjects": 4, "compositionVersion": 29, "tracker": args.tracker,
        "cameraMotion": args.camera_motion, "zoom": args.zoom,
        "output": [args.output_width, args.output_height, args.window_top, args.window_height],
        "shots": json.loads(Path(args.shots).read_text(encoding="utf-8"))["shots"] if args.shots else None}
    args.observations = ObservationStore(cache_dir / "observations.sqlite", detection_signature)
    args.shot_frames = None
    if args.shots:
        args.shot_frames = [shot["startFrame"] for shot in json.loads(Path(args.shots).read_text(encoding="utf-8"))["shots"]]
    person_model = ball_model = None
    tracked = {}
    totals = {"samples": 0, "ball": 0.0, "player": 0.0, "joint": 0.0, "joint_fit": 0.0, "subject": 0.0, "highlight": 0.0}
    for index, moment in enumerate(moments):
        args.scene_index, args.scene_total = index, len(moments)
        checkpoint = cache_dir / "scenes" / (scene_key(moment, signature) + ".json")
        result = None
        if checkpoint.exists():
            try:
                result = json.loads(checkpoint.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                pass
        reused = result is not None
        if result is None:
            if person_model is None:
                person_model, ball_model = YOLO(args.model), YOLO(args.ball_model)
            result = track_moment(person_model, ball_model, capture, moment, media_width, media_height, source_fps, args)
            atomic_json(checkpoint, result)
        tracked[moment["id"]] = result
        print("TRACK_PROGRESS " + json.dumps({"completed": index + 1, "total": len(moments),
              "sceneId": moment["id"], "reused": reused, "cacheHits": args.observations.hits,
              "newFrames": args.observations.misses}), flush=True)
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
    args.observations.close()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    marker_paths = {
        "arrow": output_path.parent / "player-arrow.png",
        "ring": output_path.parent / "player-ring.png",
    }
    create_arrow(marker_paths["arrow"])
    create_ring(marker_paths["ring"])

    denominator = max(1, totals["samples"])
    payload = {
        "version": 80, "model": os.path.basename(args.model), "ballModel": os.path.basename(args.ball_model), "sampleFps": args.sample_fps, "coarseSampleFps": args.coarse_sample_fps, "device": args.device,
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

"""Choose the player making the verified decisive touch."""

import math


def player_ball_distance(player, record):
    if record.get("ball_x") is None or record.get("ball_y") is None:
        return math.inf
    return math.hypot(
        float(player.get("cx", 0)) - float(record["ball_x"]),
        (float(player.get("y2", 0)) - float(record["ball_y"])) * .52,
    )


def select_stable_action_track_id(records, annotation_start, annotation_end, minimum_coverage=.70, minimum_samples=5):
    """Return one continuously observed ball-side subject, or None when identity is unstable."""
    window = [record for record in records
              if annotation_start <= float(record.get("time", -1)) <= annotation_end]
    if len(window) < minimum_samples:
        return None
    eligible = [record for record in window
                if record.get("direct_ball") and record.get("joint_fit")
                and record.get("player_track_id") is not None
                and float(record.get("subject_confidence", 0)) >= .58]
    if len(eligible) < minimum_samples:
        return None
    counts = {}
    confidence = {}
    for record in eligible:
        track_id = record["player_track_id"]
        counts[track_id] = counts.get(track_id, 0) + 1
        confidence.setdefault(track_id, []).append(float(record.get("subject_confidence", 0)))
    track_id, hits = max(counts.items(), key=lambda item: (item[1], sum(confidence[item[0]]) / len(confidence[item[0]])))
    coverage = hits / len(window)
    mean_confidence = sum(confidence[track_id]) / len(confidence[track_id])
    return track_id if coverage >= minimum_coverage and mean_confidence >= .65 else None


def select_scorer_track_id(records, contact_time):
    candidates = []
    for record in records:
        if not (contact_time - .45 <= record["time"] <= contact_time + .16) or not record.get("direct_ball"):
            continue
        people = record.get("players") or []
        for player in people:
            track_id = player.get("trackId")
            distance = player_ball_distance(player, record)
            if (track_id is None or distance > .11 or player.get("pitchSupport", 0) < .08
                    or player.get("confidence", 0) < .35):
                continue
            timing = abs(float(record["time"]) - float(contact_time))
            # Inspect every player at the ball, not only the subject that the
            # camera tracker happened to lock before the decisive touch.
            score = distance * 4.5 + timing * .72 + (0.025 if record["time"] > contact_time + .04 else 0)
            score -= min(12, float(player.get("trackAge", 0))) * .002
            candidates.append((score, timing, distance, track_id))
    if candidates:
        return min(candidates)[3]

    # Backward compatibility for sparse fixtures and degraded detections.
    eligible = [record for record in records
        if contact_time - .45 <= record["time"] <= contact_time + .12
        and record.get("direct_ball") and record.get("joint_fit")
        and record.get("player_track_id") is not None
        and record.get("subject_confidence", 0) >= .48]
    possessing = [record for record in eligible if record.get("possession")]
    choices = possessing or eligible
    if not choices:
        return None
    return min(choices, key=lambda record: (
        abs(record["time"] - contact_time),
        record["time"] > contact_time,
        -record.get("subject_confidence", 0),
    ))["player_track_id"]

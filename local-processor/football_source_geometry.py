"""Source-observed football destinations for trajectory search, never outcome proof."""

import math


def goalkeeper_targets(frames, attack_direction, maximum_gap=1.8):
    """Return a per-frame keeper lane only when a repeatable role is visible.

    Broadcast pans move the keeper in image coordinates.  A fixed semantic
    goal X therefore cannot be used throughout a shot.  These targets are a
    ball-association prior; they do not assert a goal or create ball detections.
    """
    if attack_direction not in {"left", "right"}:
        return {}
    output = {}
    start = 0
    for end in range(1, len(frames) + 1):
        if end < len(frames) and not frames[end].get("cut"):
            continue
        shot = frames[start:end]
        observations = []
        previous = None
        for index, frame in enumerate(shot):
            people = [person for person in frame.get("people", [])
                      if person.get("role") == "goalkeeper"
                      and person.get("confidence", 0) >= .30
                      and person.get("pitchSupport", 0) >= .04
                      and isinstance(person.get("cx"), (int, float))
                      and math.isfinite(person["cx"])]
            if not people:
                continue
            if previous is None:
                side = ([person for person in people if person["cx"] <= .5]
                        if attack_direction == "left" else
                        [person for person in people if person["cx"] >= .5])
                if not side:
                    continue
                chosen = min(side, key=lambda person: person["cx"]) if attack_direction == "left" else max(
                    side, key=lambda person: person["cx"])
            else:
                chosen = min(people, key=lambda person: abs(person["cx"] - previous))
                if abs(chosen["cx"] - previous) > .35:
                    continue
            previous = chosen["cx"]
            observations.append((index, frame["time"], previous))
        # One isolated role detection is not sufficient to redirect a shot.
        if len(observations) >= 3 and observations[-1][1] - observations[0][1] >= .15:
            for index, frame in enumerate(shot):
                before = [item for item in observations if item[0] <= index]
                after = [item for item in observations if item[0] >= index]
                left = before[-1] if before else None
                right = after[0] if after else None
                value = None
                if left and right and right[1] - left[1] <= maximum_gap:
                    portion = (frame["time"] - left[1]) / max(.001, right[1] - left[1])
                    value = left[2] + (right[2] - left[2]) * portion
                elif left and frame["time"] - left[1] <= maximum_gap:
                    value = left[2]
                if value is not None:
                    output[frame["frame"]] = value
        start = end
    return output


def on_target_keeper_handoff(event_type, phase, elapsed, contact_time,
                             keeper_x, ball_x, view_width, recently_linked=False):
    """Use an observed keeper lane after an on-target shot reaches its result.

    This only chooses camera context. The crop review must still observe the
    actual ball and result; a keeper detection never proves a save or goal.
    """
    if event_type not in {"save", "shot_on_target"} or phase not in {"flight", "payoff"}:
        return False
    if not isinstance(keeper_x, (int, float)) or not math.isfinite(keeper_x):
        return False
    if elapsed < contact_time + .15:
        return False
    return recently_linked or (isinstance(ball_x, (int, float))
        and math.isfinite(ball_x) and abs(ball_x - keeper_x) <= max(.10, view_width * .42))

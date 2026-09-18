"""Ball-first framing constraints, independent of detector/model packages."""
import math

import numpy as np
from scipy import sparse

try:
    import osqp
except ImportError:  # setup verification reports this; keep tests diagnosable.
    osqp = None


def _global_bounds(view_size):
    half = view_size / 2
    return half, 1 - half


def camera_ownership_phase(record):
    """Return the subject that owns the virtual camera for this sample.

    Setup and contact belong to the ball carrier.  Flight, continuation and
    payoff belong to the ball/destination.  A solver may smooth inside either
    interval, but must not anticipate a later owner before the current action
    has completed.
    """
    explicit = record.get("camera_owner")
    if explicit in {"carrier", "ball", "hold", "payoff"}:
        return explicit
    phase = str(record.get("action_phase") or "setup")
    if phase in {"setup", "contact"}:
        return "carrier"
    if phase in {"flight", "continuation", "payoff"}:
        return "ball"
    return phase


def _box_center_bounds(start, end, view_size, edge):
    half = view_size / 2
    low = max(half, end + edge - half)
    high = min(1 - half, start - edge + half)
    if low > high:
        low = max(half, end - half)
        high = min(1 - half, start + half)
    return (low, high) if low <= high else _global_bounds(view_size)


def framing_bounds(record, view_width):
    half = view_width / 2
    phase = "setup" if camera_ownership_phase(record) == "carrier" else record.get("action_phase")
    # Gameplay composition needs more than mathematical containment. Preserve
    # roughly eleven percent of the portrait width around the complete player
    # and ball so neither subject sits half-clipped against an output edge.
    edge = min(0.05, view_width * 0.15) if phase in {"setup", "contact"} \
        else min(0.032, view_width * 0.09)
    global_bounds = _global_bounds(view_width)
    payoff = record.get("payoff_box")
    if payoff is not None and payoff[2] - payoff[0] <= view_width:
        # A goal is not readable when the crop contains only an empty patch of
        # net. Keep a locally observed goal-side player and the independently
        # verified goalmouth anchor together whenever portrait geometry allows.
        subject = record.get("outcome_subject")
        goal_anchor = record.get("goal_focus_x")
        if not isinstance(goal_anchor, (int, float)) or not math.isfinite(goal_anchor):
            goal_anchor = (payoff[0] + payoff[2]) / 2
        if subject is not None:
            left = min(goal_anchor, subject["x1"])
            right = max(goal_anchor, subject["x2"])
            context_edge = min(edge, view_width * .045)
            if right - left + context_edge * 2 <= view_width:
                low = max(half, right + context_edge - half)
                high = min(1 - half, left - context_edge + half)
                if low <= high:
                    return low, high
        # Independently observed outcome region outranks a boot-like ball false
        # positive elsewhere on the pitch. Never fabricate a ball coordinate.
        low = max(half, payoff[2] - half)
        high = min(1 - half, payoff[0] + half)
        if low <= high:
            return low, high
    if (phase in {"setup", "contact"} and record.get("camera_owner") == "hold"
            and record.get("player_x1") is None and record.get("player_x2") is None):
        return global_bounds
    ball = record.get("ball_x")
    if ball is None or (record.get("direct_ball") is False and record.get("ball_guidance") is not True):
        # A short ball occlusion must not release the crop toward an unrelated
        # player or empty grass. Preserve the already-associated complete player
        # during setup/contact; the shot-level solver holds this envelope until
        # trustworthy ball or payoff guidance resumes.
        if (phase in {"setup", "contact"}
                and record.get("subject_recently_ball_linked") is True
                and record.get("player_x1") is not None and record.get("player_x2") is not None):
            return _box_center_bounds(record["player_x1"], record["player_x2"], view_width, edge)
        return global_bounds
    # During flight the passer can no longer fit. Never drop the ball constraint
    # just because that old player/ball pair spans more than a portrait crop.
    left = right = ball
    if record.get("player_x") is not None:
        pair_left = min(ball, record["player_x1"])
        pair_right = max(ball, record["player_x2"])
        owner_near_ball = abs(ball - record["player_x"]) <= 0.13
        # Legacy/unclassified samples stay continuous with their local carrier;
        # an explicit flight phase is required before a distant passer may be
        # released. This prevents a threshold crossing from becoming a camera
        # jump between two adjacent detector samples.
        phase_requires_pair = phase in {None, "setup", "contact"}
        if (phase_requires_pair or owner_near_ball) and pair_right - pair_left + 2 * edge <= view_width:
            left, right = pair_left, pair_right
    low = max(half, right + edge - half)
    high = min(1 - half, left - edge + half)
    # A subject at the physical source edge cannot have an extra safe margin.
    if low > high:
        low = max(half, right - half)
        high = min(1 - half, left + half)
    # Containment alone is not editorially useful: a ball at the extreme edge
    # still leaves most of a portrait crop on empty grass. Keep the observed
    # football in the middle 50% of the output whenever that is compatible
    # with retaining the complete active player. At a physical source edge,
    # visibility wins because centering is geometrically impossible.
    if phase in {"setup", "contact", "flight", "payoff"}:
        central_low = max(half, ball - view_width * .25)
        central_high = min(1 - half, ball + view_width * .25)
        centered_low = max(low, central_low)
        centered_high = min(high, central_high)
        if centered_low <= centered_high:
            low, high = centered_low, centered_high
    return (low, high) if low <= high else global_bounds


def vertical_framing_bounds(record, view_height):
    """Protect complete bodies and the ball when zoom makes Y movable."""
    global_bounds = _global_bounds(view_height)
    if view_height >= .999:
        return global_bounds
    phase = "setup" if camera_ownership_phase(record) == "carrier" else record.get("action_phase")
    edge = min(.035, view_height * .055) if phase in {"setup", "contact"} else min(.025, view_height * .04)
    payoff = record.get("payoff_box")
    if payoff is not None and payoff[3] - payoff[1] <= view_height:
        return _box_center_bounds(payoff[1], payoff[3], view_height, edge)
    values = []
    if record.get("ball_y") is not None and (record.get("direct_ball") is not False or record.get("ball_guidance") is True):
        values.append(record["ball_y"])
    if record.get("player_top") is not None and record.get("player_bottom") is not None:
        values.extend([record["player_top"], record["player_bottom"]])
    if not values:
        return global_bounds
    return _box_center_bounds(min(values), max(values), view_height, edge)


def _required_bounds(records, view_size, axis):
    raw = [framing_bounds(record, view_size) if axis == "x" else vertical_framing_bounds(record, view_size)
           for record in records]
    global_bounds = _global_bounds(view_size)
    constrained = [bounds != global_bounds for bounds in raw]
    # Keep the most recent verified subject envelope during brief detector gaps.
    # Never bridge a broadcast cut, and never manufacture a new coordinate.
    last_required = None
    for index in range(len(raw)):
        if records[index]["scene_cut"]:
            last_required = None
        if constrained[index]:
            last_required = index
            continue
        if last_required is not None and records[index]["time"] - records[last_required]["time"] <= .65:
            raw[index] = raw[last_required]
    return raw


def flight_target(ball, player, velocity, view_width, fallback):
    if ball is None:
        return fallback
    lead = max(-0.07, min(0.07, velocity * 0.28))
    center = ball + lead
    if player is not None:
        span = max(ball, player["x2"]) - min(ball, player["x1"])
        if span + min(0.056, view_width * 0.15) * 2 <= view_width:
            center = (ball * 3 + player["cx"]) / 4 + lead
    return max(0, min(1, center))


def reconcile_goal_destination(observations, ball_path, start, contact_time, payoff_time,
                               goal_focus_x, payoff_box):
    """Flag a ball path that contradicts a verified visible goal-side hint."""
    if goal_focus_x is None or payoff_box is None or not ball_path:
        return goal_focus_x, payoff_box, None
    samples = []
    for observation in observations:
        candidate = ball_path.get(observation.get("frame"))
        if candidate is None:
            continue
        elapsed = float(observation.get("time", start)) - float(start)
        samples.append((elapsed, float(candidate["cx"]), float(candidate["cy"])))
    contact = [sample for sample in samples if contact_time - .32 <= sample[0] <= contact_time + .24]
    flight = [sample for sample in samples if contact_time + .28 <= sample[0] <= payoff_time + .12]
    # Two post-contact samples are enough to reject a route that travels in
    # the opposite direction to an independently verified goalmouth. Requiring
    # three allowed a short-lived false positive to steer the crop away.
    if len(contact) < 2 or len(flight) < 2:
        return goal_focus_x, payoff_box, None
    contact_x = float(np.median([sample[1] for sample in contact]))
    tail = flight[-min(5, len(flight)):]
    flight_x = float(np.median([sample[1] for sample in tail]))
    displacement = flight_x - contact_x
    semantic_displacement = float(goal_focus_x) - contact_x
    if abs(displacement) < .055 or displacement * semantic_displacement >= 0:
        return goal_focus_x, payoff_box, None
    return goal_focus_x, payoff_box, "observed_ball_path_conflicts_with_verified_goal_side"


def goal_outcome_subject(people, payoff_box, goal_focus_x, ball=None):
    """Select visible goal-side player context without claiming an identity."""
    if not people or ball is None or (payoff_box is None and goal_focus_x is None):
        return None
    goal_x = goal_focus_x if isinstance(goal_focus_x, (int, float)) and math.isfinite(goal_focus_x) \
        else (payoff_box[0] + payoff_box[2]) / 2
    goal_y = (payoff_box[1] + payoff_box[3]) / 2 if payoff_box is not None else .56
    left = payoff_box[0] - .16 if payoff_box is not None else goal_x - .22
    right = payoff_box[2] + .16 if payoff_box is not None else goal_x + .22
    top = payoff_box[1] - .18 if payoff_box is not None else .20
    bottom = min(1.0, payoff_box[3] + .16) if payoff_box is not None else .94
    candidates = [
        person for person in people
        if person.get("pitchSupport", 0.0) >= .04
        and person.get("y2", 0.0) - person.get("y1", 0.0) >= .032
        and (payoff_box is None or abs(person.get("cx", -1) - goal_x)
             <= max(.18, (payoff_box[2] - payoff_box[0]) * .75))
        and left <= person.get("cx", -1) <= right
        and top <= person.get("cy", -1) <= bottom
        # A player near the goal is not automatically involved. Require a
        # visible ball-linked relationship; otherwise hold the verified
        # goalmouth and never center an arbitrary defender.
        and math.hypot(person.get("cx", -1) - ball[0],
                       (person.get("y2", -1) - ball[1]) * .52) <= .14
    ]
    if not candidates:
        return None
    def score(person):
        goal_distance = abs(person["cx"] - goal_x) * 1.55 + abs(person["cy"] - goal_y) * .24
        ball_distance = math.hypot(person["cx"] - ball[0], (person["cy"] - ball[1]) * .45) if ball is not None else .25
        maturity_bonus = min(.05, max(0, person.get("trackAge", 1) - 1) * .006)
        return goal_distance + ball_distance * .22 - maturity_bonus - person.get("confidence", 0) * .03
    return min(candidates, key=score)


def goal_outcome_target(payoff_box, goal_focus_x, subject, ball, phase, fallback_x):
    """Aim at the shot destination, never an unsupported empty-field point."""
    if payoff_box is None and goal_focus_x is None:
        return fallback_x, .5
    goal_x = goal_focus_x if isinstance(goal_focus_x, (int, float)) and math.isfinite(goal_focus_x) \
        else (payoff_box[0] + payoff_box[2]) / 2
    goal_y = (payoff_box[1] + payoff_box[3]) / 2 if payoff_box is not None else .56
    x_items = [(goal_x, 2.2 if phase == "flight" else 3.0)]
    y_items = [(goal_y, 1.8 if phase == "flight" else 2.6)]
    if subject is not None:
        x_items.append((subject["cx"], 1.8 if phase == "flight" else 2.8))
        y_items.append((subject["cy"], 1.4 if phase == "flight" else 2.2))
    if ball is not None:
        x_items.append((ball[0], 3.2 if phase == "flight" else 1.0))
        y_items.append((ball[1], 2.6 if phase == "flight" else .8))
    total_x = sum(weight for _, weight in x_items)
    total_y = sum(weight for _, weight in y_items)
    return (
        sum(value * weight for value, weight in x_items) / total_x,
        sum(value * weight for value, weight in y_items) / total_y,
    )


def possession_handoff(people, ball, incumbent, pending_id, pending_count):
    """Transfer only after a receiver is repeatedly closer to the observed ball."""
    if ball is None or incumbent is None or not people:
        return None
    distance = lambda p: math.hypot(p["cx"] - ball[0], (p["y2"] - ball[1]) * .52)
    nearest = min(people, key=distance)
    if (nearest["trackId"] == incumbent["trackId"] or distance(incumbent) <= .13
            or distance(nearest) > .10 or distance(nearest) + .035 >= distance(incumbent)):
        return None
    count = pending_count + 1 if nearest["trackId"] == pending_id else 1
    return nearest, count


def _difference_matrix(times, order):
    timeline = np.asarray(times, dtype=float)
    count = len(timeline)
    if count <= order:
        return sparse.csc_matrix((0, count))
    if order == 1:
        dt = np.maximum(.001, np.diff(timeline))
        return sparse.diags([-1 / dt, 1 / dt], [0, 1], shape=(count - 1, count), format="csc")
    if order == 2:
        matrix = sparse.lil_matrix((count - 2, count))
        dt = np.maximum(.001, np.diff(timeline))
        for index in range(count - 2):
            scale = 2 / (dt[index] + dt[index + 1])
            matrix[index, index] = scale / dt[index]
            matrix[index, index + 1] = -scale * (1 / dt[index] + 1 / dt[index + 1])
            matrix[index, index + 2] = scale / dt[index + 1]
        return matrix.tocsc()
    return sparse.diags([-1, 3, -3, 1], [0, 1, 2, 3], shape=(count - 3, count), format="csc")


def _solve_shot_path(targets, times, bounds, max_speed, max_acceleration):
    count = len(targets)
    if count == 1:
        return [max(bounds[0][0], min(bounds[0][1], targets[0]))]
    if osqp is None:
        return None
    desired = np.asarray(targets, dtype=float)
    identity = sparse.eye(count, format="csc")
    velocity = _difference_matrix(times, 1)
    acceleration = _difference_matrix(times, 2)
    jerk = _difference_matrix(times, 3)
    # Stay close enough to the semantic target while strongly preferring a
    # tripod hold or one deliberate pan.  Dense detector observations must not
    # become tiny visible camera corrections.
    # Ball-first reframing: keep enough target attraction that a long run or
    # pass remains near the portrait center. Velocity/acceleration penalties
    # still turn detector samples into one smooth, deliberate camera move.
    target_weight = 1.20
    objective = target_weight * identity + .90 * (velocity.T @ velocity) + 8.0 * (acceleration.T @ acceleration)
    if jerk.shape[0]:
        objective = objective + 3.0 * (jerk.T @ jerk)
    matrix_parts = [identity]
    lower = [np.asarray([item[0] for item in bounds])]
    upper = [np.asarray([item[1] for item in bounds])]
    if max_speed is not None and velocity.shape[0]:
        matrix_parts.append(velocity)
        lower.append(np.full(velocity.shape[0], -max_speed))
        upper.append(np.full(velocity.shape[0], max_speed))
    if max_acceleration is not None and acceleration.shape[0]:
        matrix_parts.append(acceleration)
        lower.append(np.full(acceleration.shape[0], -max_acceleration))
        upper.append(np.full(acceleration.shape[0], max_acceleration))
    constraints = sparse.vstack(matrix_parts, format="csc")
    solver = osqp.OSQP()
    solver.setup(P=sparse.csc_matrix(2 * objective), q=-(2 * target_weight) * desired,
                 A=constraints, l=np.concatenate(lower), u=np.concatenate(upper),
                 verbose=False, polishing=True, eps_abs=1e-5, eps_rel=1e-5, max_iter=12000)
    result = solver.solve()
    if result.x is None or result.info.status_val not in {1, 2} or not np.all(np.isfinite(result.x)):
        return None
    return [max(low, min(high, float(value))) for value, (low, high) in zip(result.x, bounds)]


def constrained_camera(targets, records, view_width, max_speed=0.32, axis="x"):
    """Offline look-ahead: project smooth targets into per-frame visible bounds.

    Expand reachable intervals backwards so pans start before a fast pass reaches
    the edge. When physics makes the speed limit impossible, visibility wins and
    the caller's measured motion quality gate reports the violation.
    """
    if not records:
        return []
    bounds = _required_bounds(records, view_width, axis)
    reachable = bounds[:]
    for i in range(len(records) - 2, -1, -1):
        if (records[i + 1]["scene_cut"]
                or camera_ownership_phase(records[i + 1]) != camera_ownership_phase(records[i])):
            continue
        dt = max(0.001, records[i + 1]["time"] - records[i]["time"])
        low = max(bounds[i][0], reachable[i + 1][0] - max_speed * dt)
        high = min(bounds[i][1], reachable[i + 1][1] + max_speed * dt)
        if low <= high:
            reachable[i] = (low, high)
    out = []
    velocity = 0.0
    for i, target in enumerate(targets):
        low, high = reachable[i]
        if not i or records[i]["scene_cut"]:
            position = max(low, min(high, target))
            velocity = 0.0
        else:
            dt = max(0.001, records[i]["time"] - records[i - 1]["time"])
            desired_velocity = max(-max_speed, min(max_speed, (target - out[-1]) * 2.5))
            velocity = max(velocity - 0.7 * dt, min(velocity + 0.7 * dt, desired_velocity))
            position = max(low, min(high, out[-1] + velocity * dt))
            velocity = (position - out[-1]) / dt
        out.append(position)
    # Symmetric smoothing cannot cross cuts or remove containment constraints.
    for _ in range(12):
        smoothed = out[:]
        for i in range(1, len(out) - 1):
            if (records[i]["scene_cut"] or records[i + 1]["scene_cut"]
                    or camera_ownership_phase(records[i - 1]) != camera_ownership_phase(records[i])
                    or camera_ownership_phase(records[i + 1]) != camera_ownership_phase(records[i])):
                continue
            target = (out[i - 1] + out[i] * 2 + out[i + 1]) / 4
            low, high = reachable[i]
            smoothed[i] = max(low, min(high, target))
        out = smoothed
    # Optimize the whole broadcast shot. Containment is always hard; speed and
    # acceleration are relaxed only when a source pan makes them infeasible.
    start = 0
    for end in range(1, len(records) + 1):
        boundary = (end == len(records) or records[end]["scene_cut"]
                    or camera_ownership_phase(records[end]) != camera_ownership_phase(records[end - 1]))
        if not boundary:
            continue
        if end - start >= 3:
            # Follow the verified football targets through the broadcast shot.
            # The quadratic motion solver below already suppresses detector
            # jitter, so replacing these targets with one static anchor leaves
            # the football near an edge and centers unrelated players.
            shot_targets = targets[start:end]
            shot_times = [record["time"] for record in records[start:end]]
            shot_bounds = bounds[start:end]
            # A phase handoff is a pan beginning after contact, not a jump or
            # an anticipatory move during setup. Pin the first post-contact
            # sample to the completed carrier crop whenever containment allows.
            if start > 0 and not records[start]["scene_cut"]:
                inherited = out[start - 1]
                low, high = shot_bounds[0]
                inherited = max(low, min(high, inherited))
                shot_bounds = [(inherited, inherited), *shot_bounds[1:]]
                shot_targets = [inherited, *shot_targets[1:]]
            solved = None
            for speed, acceleration_limit in ((max_speed, .75), (max_speed * 1.5, 1.25),
                                               (max_speed * 2.5, 2.25), (None, None)):
                solved = _solve_shot_path(shot_targets, shot_times, shot_bounds, speed, acceleration_limit)
                if solved is not None:
                    break
            if solved is not None:
                out[start:end] = solved
        start = end
    return out


def visible_in_crop(x, y, camera_x, camera_y, view_width, view_height, margin=0.0):
    return (x is not None and y is not None and math.isfinite(x) and math.isfinite(y)
            and abs(x - camera_x) <= view_width / 2 - margin
            and abs(y - camera_y) <= view_height / 2 - margin)


def active_joint_fit_in_crop(record, camera_x, camera_y, view_width, view_height):
    """Verify the currently involved player and ball, independent of annotation identity."""
    margin = min(0.035, view_width * 0.11) if record.get("action_phase") in {"setup", "contact"} else 0.0
    return bool(
        visible_in_crop(record.get("ball_x"), record.get("ball_y"), camera_x, camera_y, view_width, view_height, margin)
        and visible_in_crop(record.get("player_x1"), record.get("player_top"), camera_x, camera_y, view_width, view_height, margin)
        and visible_in_crop(record.get("player_x2"), record.get("player_bottom"), camera_x, camera_y, view_width, view_height, margin)
    )


def observed_payoff_box(moment, absolute_time):
    evidence = moment.get("trackingBrief", {}).get("payoffEvidence")
    if not isinstance(evidence, dict) or evidence.get("verified") is not True or evidence.get("eventType") != moment.get("eventType"):
        return None
    box = evidence.get("targetBox")
    if not isinstance(box, list) or len(box) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1 for v in box):
        return None
    if box[0] >= box[2] or box[1] >= box[3]:
        return None
    if moment.get("eventType") == "goal":
        goal_focus = moment.get("trackingBrief", {}).get("goalFocusX")
        if isinstance(goal_focus, (int, float)) and math.isfinite(goal_focus):
            center_x = (box[0] + box[2]) / 2
            # A semantic rectangle far from the separately identified goal side
            # is not allowed to redirect per-frame ball tracking.
            if abs(center_x - goal_focus) > max(.18, (box[2] - box[0]) * .75):
                return None
    start, end = evidence.get("startTime"), evidence.get("endTime")
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (start, end)):
        return None
    if end - start < 0.5 or absolute_time < start:
        return None
    # A verified goalmouth becomes the authoritative framing target after the
    # finish. The ball is commonly occluded by the net, goalkeeper or players;
    # do not chase a late false detector hit away from the outcome.
    if moment.get("eventType") in {"goal", "disallowed_goal"}:
        moment_end = moment.get("endTime")
        hold_until = max(end, float(moment_end)) if isinstance(moment_end, (int, float)) and math.isfinite(moment_end) else end
        return box if absolute_time <= hold_until else None
    return box if absolute_time <= end else None

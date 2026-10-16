"""Offline association of observed ball candidates. Missing frames stay missing.

Unlike greedy nearest-box selection, beam search uses the complete shot to avoid
switching to a distant boot/advert when the actual ball is briefly weak.
"""
import math


def candidate_diameter(ball, view_width, output_width=1080, source_aspect=16/9):
    # X and Y are normalized against DIFFERENT native dimensions. Using Y as
    # if it were normalized against width enlarged every ball-size estimate.
    return max(ball['x2']-ball['x1'],(ball['y2']-ball['y1'])/source_aspect)/view_width*output_width


def maximum_candidate_diameter(ball, people, view_width, output_width=1080, source_aspect=16/9):
    # A foreground football is larger than a four-pixel wide-shot football.
    # Keep a measured ball proportionate to a nearby observed player's body;
    # a big logo/advert with no relevant nearby player still gets the 70px cap.
    near=[p for p in people if p.get('pitchSupport',0)>=.08
        and math.hypot(ball['cx']-p['cx'],(ball['cy']-p['y2'])/source_aspect)<=.12]
    bodies=sorted((p['y2']-p.get('y1',p['y2']))/source_aspect/view_width*output_width
        for p in people if p.get('pitchSupport',0)>=.08 and p.get('role')!='referee')
    # After contact a foreground ball moves away from the player's feet, while
    # remaining at the same apparent scale. Use the current shot's observed
    # player scale as well as the nearest player; distance must not shrink a
    # genuine moving football back to the wide-shot size limit.
    shot_body=bodies[min(len(bodies)-1,int(len(bodies)*.75))] if bodies else 0
    body=max([shot_body,*((p['y2']-p.get('y1',p['y2']))/source_aspect/view_width*output_width
        for p in near)])
    return max(70,min(240,body*.25))


def semantic_region_distance(ball, frame):
    anchor=frame.get('semantic_ball_region')
    if anchor is None:
        return None
    x1,y1,x2,y2,radius=anchor
    dx=max(0,x1-ball['cx'],ball['cx']-x2)
    dy=max(0,y1-ball['cy'],ball['cy']-y2)*.6
    return math.hypot(dx,dy)/max(.001,radius)


def semantic_region_cost(ball, frame):
    distance = semantic_region_distance(ball, frame)
    if distance is None:
        return 0.0
    cost = 1.5 * distance**2
    # Source coordinates do not interpolate linearly while the broadcast pans
    # or zooms. A corridor between sparse anchors can guide acquisition, but
    # must not make an actually detected moving ball more costly than missing.
    return min(.6, cost) if frame.get('semantic_anchor_observed') is False else cost


def interpolate_observation_gaps(frames, path, maximum_gap=.45):
    """Camera guidance between two observations; never marks a missing frame direct."""
    output = {}
    previous = None
    for index, frame in enumerate(frames):
        if frame.get("cut"):
            previous = None
        current = path.get(frame["frame"])
        if current is None:
            continue
        if previous is not None:
            old_index, old_frame, old_ball = previous
            gap = frame["time"] - old_frame["time"]
            if 0 < gap <= maximum_gap:
                for missing in frames[old_index + 1:index]:
                    alpha = (missing["time"] - old_frame["time"]) / gap
                    output[missing["frame"]] = (old_ball["cx"] * (1-alpha) + current["cx"] * alpha,
                        old_ball["cy"] * (1-alpha) + current["cy"] * alpha)
        previous = index, frame, current
    return output


def trajectory_camera_guidance(frames, path, maximum_gap=.75, edge_hold=.55, opening_hold=3.0):
    """Trusted camera-only guidance from observed trajectory endpoints.

    Interpolate short internal gaps and briefly hold the nearest real endpoint
    at a shot edge. This never turns guidance into a direct ball observation.
    """
    output = interpolate_observation_gaps(frames, path, maximum_gap)
    start = 0
    for end in range(1, len(frames) + 1):
        if end < len(frames) and not frames[end].get("cut"):
            continue
        shot = frames[start:end]
        observed = [(index, path.get(frame["frame"])) for index, frame in enumerate(shot)]
        observed = [(index, ball) for index, ball in observed if ball is not None]
        if observed:
            first_index, first_ball = observed[0]
            first_time = shot[first_index]["time"]
            for frame in shot[:first_index]:
                # A selected setup can begin before the tiny ball is directly
                # detectable. Pre-position at the first coherent ball path
                # instead of snapping away from a coarse semantic crop.
                if first_time - frame["time"] <= opening_hold:
                    output[frame["frame"]] = (first_ball["cx"], first_ball["cy"])
            last_index, last_ball = observed[-1]
            last_time = shot[last_index]["time"]
            for frame in shot[last_index + 1:]:
                if frame["time"] - last_time <= edge_hold:
                    output[frame["frame"]] = (last_ball["cx"], last_ball["cy"])
        start = end
    return output

def choose_trajectory(frames, view_width, output_width=1080, beam_width=24,
                      initial_focus_x=None, attack_direction=None,
                      contact_time=None, goal_focus_x=None, goal_focus_y=None, route_end_time=None,
                      source_aspect=16/9):
    """Choose one coherent football trajectory from noisy small-object detections.

    A football detector frequently gives a white boot a much higher confidence
    than the real four-pixel ball.  For an action with a verified contact time
    and goal side, confidence alone is therefore unsafe.  The tactical route is
    used as a *trajectory* prior: it grows only near contact, rewards progress
    toward the known payoff, and penalizes sustained movement in the opposite
    direction.  It never fabricates an observation.
    """
    result = {}
    start = 0
    for end in range(1, len(frames) + 1):
        if end < len(frames) and not frames[end].get("cut"):
            continue
        shot = frames[start:end]
        # score, last observed candidate, last observed time, linked path
        beam = [(0.0, None, 0.0, None)]
        shot_start_time = shot[0]["time"] if shot else 0.0
        role_times=[f['time'] for f in shot if any(b.get('roleDetector') is True
            and b['confidence']>=.35 and (b.get('pitchSupport',0)>=.1
                or b.get('closeupBall') is True and b['confidence']>=.6)
            and 4<=candidate_diameter(b,view_width,output_width,source_aspect)
                <=maximum_candidate_diameter(b,f['people'],view_width,output_width,source_aspect)
            for b in f['balls'])]
        for frame in shot:
            frame_goal_x = frame.get("goal_focus_x")
            if not isinstance(frame_goal_x, (int, float)) or not math.isfinite(frame_goal_x):
                frame_goal_x = goal_focus_x
            route_context = (attack_direction in {"left", "right"}
                and isinstance(contact_time, (int, float))
                and isinstance(frame_goal_x, (int, float))
                and (route_end_time is None or frame['time']<=route_end_time))
            candidates = []
            for ball in frame["balls"]:
                diameter = candidate_diameter(ball,view_width,output_width,source_aspect)
                # Keep weak, tiny-ball detections when a verified football route
                # can disambiguate them.  The detector is already invoked at a
                # low threshold specifically because a broadcast ball can be
                # only four pixels wide.
                distance=semantic_region_distance(ball,frame)
                # The same tiny football must not be discarded merely because
                # this is a save/pass rather than a goal. A source guide can
                # retain a measured candidate near its search region; it cannot
                # provide a missing detection or approve the resulting crop.
                guided_candidate=distance is not None and distance<=1
                minimum_confidence = .03 if route_context or guided_candidate or frame.get('motion_ball_region') else .12
                maximum=maximum_candidate_diameter(ball,frame['people'],view_width,output_width,source_aspect)
                if not 4 <= diameter <= maximum or ball["confidence"] < minimum_confidence:
                    continue
                near = min((math.hypot(ball["cx"] - p["cx"], (ball["cy"] - p["y2"]) * .52)
                            for p in frame["people"] if p.get("pitchSupport", 0) >= .08), default=1)
                if (ball.get("pitchSupport", 0) < .1 and near > .11 and not frame.get("airborne")
                    and not (ball.get('closeupBall') is True and ball['confidence']>=.6)):
                    continue
                payoff = frame.get("payoff_box")
                if payoff and not (payoff[0] <= ball["cx"] <= payoff[2] and payoff[1] <= ball["cy"] <= payoff[3]):
                    continue
                candidates.append((ball, near))
            def payoff_route_strength_at(timestamp):
                """Activate goalmouth attraction only after the decisive touch.

                A pass or cross can still be far from goal immediately before
                contact. Pulling every pre-contact candidate toward the known
                goal location selects boots and penalty-box markings instead
                of the real football, then crops out both passer and scorer.
                Direction and temporal continuity govern setup/contact; the
                verified payoff corridor becomes useful during ball flight.
                """
                seconds_after_contact = timestamp - float(contact_time)
                # The broadcast camera can pan after contact, changing every
                # normalized goal coordinate. A current semantic search region
                # already constrains measured candidates in THIS frame; an
                # older static goal location must not contradict it and make
                # "missing" cheaper than the actual ball inside that region.
                if frame.get('semantic_ball_region') is not None:
                    return 0.0
                if seconds_after_contact <= 0:
                    return 0.0
                return max(0.0, min(1.0, seconds_after_contact / .65))

            def acquisition_cost(pair):
                ball, _ = pair
                score = -math.log(max(.01, ball["confidence"]))
                distance=semantic_region_distance(ball,frame)
                if distance is not None:
                    score+=semantic_region_cost(ball,frame)
                if route_context:
                    strength = payoff_route_strength_at(frame["time"])
                    horizontal_gap = abs(ball["cx"] - float(frame_goal_x))
                    score += (horizontal_gap * 4.0 + max(0.0, horizontal_gap - .24) * 30.0) * strength
                    if isinstance(goal_focus_y, (int, float)):
                        vertical_gap = abs(ball["cy"] - float(goal_focus_y))
                        score += (vertical_gap * 6.0 + max(0.0, vertical_gap - .12) * 50.0) * strength
                return score

            has_role_ball=any(b.get('roleDetector') is True and b['confidence']>=.35
                and (b.get('pitchSupport',0)>=.1 or b.get('closeupBall') is True
                    and b['confidence']>=.6) for b,_ in candidates)
            role_context=has_role_ball or any(abs(frame['time']-t)<=.85 for t in role_times)
            def detector_cost(ball):
                region = frame.get('motion_ball_region')
                if region:
                    distance = math.hypot(ball['cx']-region[0],(ball['cy']-region[1])*.6)
                    return min(8.0,max(0,distance-region[2])*40)
                motion = [candidate for candidate, _ in candidates if candidate.get('motionTrack') is True]
                if motion:
                    # Several native frames independently support this fast
                    # isolated trajectory. A smooth high-score boot elsewhere
                    # must not outweigh that observed movement.
                    distance = min(math.hypot(ball['cx']-candidate['cx'],
                        (ball['cy']-candidate['cy'])*.6) for candidate in motion)
                    return min(8.0,max(0,distance-.02)*40)
                # A role-labelled football proposal comes from the full native
                # picture. Specialist-only proposals from an old small ROI are
                # often white boots. Prefer the observed full-picture football
                # while retaining its original score and all alternatives.
                agrees=any(b.get('roleDetector') is True and b['confidence']>=.35
                    and math.hypot(b['cx']-ball['cx'],(b['cy']-ball['cy'])*.6)<=.025
                    for b,_ in candidates)
                # An honest missing sample during a brief native occlusion is
                # cheaper than switching to a different player's bright boot.
                return 3.0 if role_context and ball.get('roleDetector') is not True and not agrees else 0

            # Confidence sorting discarded the true four-pixel football before
            # beam search could evaluate it. Rank acquisition using the verified
            # route and retain a wider tactical candidate set.
            candidates.sort(key=lambda pair:acquisition_cost(pair)+detector_cost(pair[0]))
            next_beam = []
            for score, previous, previous_time, path in beam:
                gap = frame["time"] - previous_time
                # In a verified goal route, choosing "missing" must not be
                # cheaper than a genuine low-confidence four-pixel football.
                native_anchor_match=frame.get('semantic_anchor_observed') is True and frame.get('semantic_ball_region') is not None and any(
                    semantic_region_distance(candidate,frame)<=1 for candidate,_ in candidates)
                next_beam.append((score + (4.0 if route_context or native_anchor_match else 2.5), previous, previous_time, (path, None)))
                for ball, near in candidates[:16 if route_context else 8]:
                    cost = -math.log(max(.01, ball["confidence"])) + min(.8, near * 3) + detector_cost(ball)
                    anchor=frame.get("semantic_ball_region")
                    if anchor is not None:
                        # A sparse semantic region is only an association
                        # prior, including uncertain same-shot search corridors.
                        # It never supplies a ball coordinate or interpolates
                        # a missing detection.
                        cost+=semantic_region_cost(ball,frame)
                    # Before a trajectory is established, a bright boot or field
                    # marking can form a very coherent but completely unrelated
                    # path. Gemini's scene crop is not per-frame tracking truth,
                    # but it is a useful weak prior for the opening acquisition.
                    # Limit this prior to the first 1.25 seconds of each source
                    # shot; once the ball moves, temporal continuity owns the path.
                    # A coarse semantic center must not overrule a verified
                    # attack route; that was the source of persistent boot lock.
                    if (not route_context
                            and isinstance(initial_focus_x, (int, float))
                            and math.isfinite(initial_focus_x)
                            and frame["time"] - shot_start_time <= 1.25):
                        focus_gap = abs(ball["cx"] - initial_focus_x)
                        cost += focus_gap * 2.2
                        if focus_gap > view_width * .9:
                            cost += 2.2
                    goal_focus = frame.get("goal_focus_x")
                    if frame.get("goal_payoff") and isinstance(goal_focus, (int, float)):
                        cost += abs(ball["cx"] - goal_focus) * 4.5
                    if route_context:
                        direction = 1.0 if attack_direction == "right" else -1.0
                        # Before contact, continuity and observed player/ball
                        # association own the route. Only after contact should
                        # the known goalmouth progressively influence the ball
                        # path; a goal-side prior before the kick can lock onto
                        # an unrelated boot and lose the scorer.
                        route_strength = payoff_route_strength_at(frame["time"])
                        horizontal_gap = abs(ball["cx"] - float(frame_goal_x))
                        cost += (horizontal_gap * 4.0 + max(0.0, horizontal_gap - .24) * 30.0) * route_strength
                        if isinstance(goal_focus_y, (int, float)):
                            vertical_gap = abs(ball["cy"] - float(goal_focus_y))
                            cost += (vertical_gap * 6.0 + max(0.0, vertical_gap - .12) * 50.0) * route_strength
                    if previous is not None:
                        distance = math.hypot(ball["cx"] - previous["cx"], (ball["cy"] - previous["cy"]) * .6)
                        # Supports real fast shots; penalizes unexplained teleports.
                        allowance = .025 + (1.8 if frame.get('motion_ball_region') or ball.get('motionTrack') is True else .65) * max(.04, gap)
                        cost += 2 * (distance / allowance) ** 2
                        if route_context and frame["time"] <= float(contact_time) + .2:
                            progress = direction * (ball["cx"] - previous["cx"])
                            # Broadcast pan can make a valid trajectory nearly
                            # stationary, but a large reverse run before contact
                            # is characteristic of a coherent false boot path.
                            cost += max(0.0, -progress - .008) * 18.0
                        if (route_context and gap > 0
                                and frame["time"] < float(contact_time) - .35):
                            # During setup, a sudden leap from the attack lane to
                            # a foreground player's boot is not football motion.
                            # Prefer an honest missing sample so camera guidance
                            # can bridge between real observations.
                            vertical_speed = abs(ball["cy"] - previous["cy"]) / gap
                            cost += max(0.0, vertical_speed - .45) * 4.5
                    next_beam.append((score + cost, ball, frame["time"], (path, ball)))
            # Keep distinct current observations, plus several gap hypotheses.
            next_beam.sort(key=lambda state: state[0])
            beam, identities = [], set()
            for state in next_beam:
                _, ball, timestamp, path = state
                identity = (round(ball["cx"], 5), round(ball["cy"], 5), timestamp, path[1] is None) if ball else (None,)
                if identity in identities:
                    continue
                identities.add(identity)
                beam.append(state)
                if len(beam) >= beam_width:
                    break
        path = min(beam, key=lambda state: state[0])[3]
        chosen = []
        while path is not None:
            path, ball = path
            chosen.append(ball)
        for frame, ball in zip(shot, reversed(chosen)):
            result[frame["frame"]] = ball
        start = end
    return result

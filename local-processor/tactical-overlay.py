"""Evidence-linked freeze drawings. Never use AI coordinates or infer offside.

Register nearby source images to the freeze image before projecting observed
ball/player positions. Ambiguous registration, identity changes and cuts omit
the drawing. Pitch maps require a separately verified pitch calibration.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np


TACTICAL_YELLOW = (36, 220, 255, 245)
PASS_WHITE = (255, 255, 255, 250)
SHADOW = (0, 0, 0, 125)


def register_frame(reference, current):
    matrix = feature_registration(reference, current)
    if matrix is not None:
        return matrix
    # Texture-poor grass can defeat ORB. Independently validate a small affine
    # alignment with ECC; do not lower feature-registration thresholds.
    ref = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
    cur = cv2.cvtColor(current, cv2.COLOR_BGR2GRAY)
    ref = cv2.resize(ref, None, fx=.5, fy=.5).astype(np.float32)/255
    cur = cv2.resize(cur, None, fx=.5, fy=.5).astype(np.float32)/255
    if ref.std() < .02 or cur.std() < .02:
        return None
    mask = np.zeros(ref.shape, np.uint8)
    mask[int(ref.shape[0]*.35):] = 255
    try:
        score, warp = cv2.findTransformECC(ref, cur, np.eye(2,3,dtype=np.float32), cv2.MOTION_AFFINE,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-6), mask, 5)
    except cv2.error:
        return None
    if score < .985 or not np.isfinite(warp).all() or abs(np.linalg.det(warp[:,:2])-1) > .08:
        return None
    warp[:,2] *= 2
    matrix = np.linalg.inv(np.vstack([warp,[0,0,1]]))
    h,w = reference.shape[:2]
    corners=np.float32([[[0,h*.35],[w,h*.35],[w,h],[0,h]]])
    moved=cv2.perspectiveTransform(corners,matrix)
    if np.max(np.linalg.norm(moved-corners,axis=2)) > w*.12:
        return None
    return matrix


def feature_registration(reference, current):
    orb = cv2.ORB_create(nfeatures=2000)
    def features(image):
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        # Use the pitch half of the image; avoid scoreboards and stadium logos.
        mask = np.zeros(gray.shape, np.uint8)
        mask[int(gray.shape[0] * .35):] = 255
        return orb.detectAndCompute(gray, mask)
    a, da = features(current)
    b, db = features(reference)
    if da is None or db is None:
        return None
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da, db, k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < .7 * p[1].distance]
    if len(good) < 30:
        return None
    src = np.float32([a[m.queryIdx].pt for m in good])
    dst = np.float32([b[m.trainIdx].pt for m in good])
    matrix, mask = cv2.findHomography(src, dst, cv2.RANSAC, 2.5)
    if matrix is None or not np.isfinite(matrix).all() or mask.mean() < .8:
        return None
    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), matrix).reshape(-1, 2)
    if np.median(np.linalg.norm(projected[mask.ravel() == 1] - dst[mask.ravel() == 1], axis=1)) > 1.5:
        return None
    return matrix


def drawing_points(records, anchor, kind):
    minimum_subject_confidence = .78 if kind == "pass" else .85
    if not anchor.get("direct_ball") or not anchor.get("joint_fit") or anchor.get("subject_confidence", 0) < minimum_subject_confidence:
        return []
    if kind == "pass":
        # The receiver must be visibly tracked in the freeze AND subsequently
        # control the ball. Both arrow endpoints use the same source frame.
        later = [r for r in records if anchor["time"] < r["time"] <= anchor["time"] + 5.0]
        if not anchor.get("possession") or any(r.get("scene_cut") for r in later):
            return []
        # Goal scenes already contain locally verified phase labels. Prefer
        # the player who owns the ball at verified contact over a nearer
        # transient track, which is often only an ID switch beside the passer.
        contact = next((r for r in later
            if r.get("action_phase") == "contact"
            and r.get("player_track_id") is not None
            and r.get("possession")
            and r.get("subject_confidence", 0) >= .70), None)
        if contact is not None and contact.get("player_track_id") != anchor.get("player_track_id"):
            identity = contact["player_track_id"]
            receiver = next((p for p in anchor.get("players", []) if p.get("trackId") == identity), None)
            if receiver is not None:
                separation = np.linalg.norm(np.subtract(
                    [anchor["ball_x"], anchor["ball_y"]], [receiver["cx"], receiver["y2"]]))
                owner = anchor.get("player_track_id")
                stable_carrier = sum(1 for record in records
                    if anchor["time"] - .5 <= record["time"] <= anchor["time"]
                    and record.get("player_track_id") == owner and record.get("possession"))
                if owner is not None and stable_carrier >= 2 and separation >= .045:
                    return [(anchor,[anchor["ball_x"],anchor["ball_y"]]),(anchor,[receiver["cx"],receiver["y2"]])]
        if anchor.get("player_track_id") is None:
            return []
        for player in anchor.get("players", []):
            identity = player.get("trackId")
            if identity is None or identity == anchor.get("player_track_id"):
                continue
            run = 0
            for record in later:
                valid = record.get("player_track_id") == identity and record.get("possession") and record.get("direct_ball") and record.get("subject_confidence", 0) >= .70
                run = run + 1 if valid else 0
                if run >= 3:
                    return [(anchor,[anchor["ball_x"],anchor["ball_y"]]),(anchor,[player["cx"],player["y2"]])]
        return []
    selected = []
    for record in records:
        delta = record["time"] - anchor["time"]
        if delta < 0:
            continue
        if delta > .6 or (delta > 0 and record.get("scene_cut")):
            break
        if kind == "run":
            if record.get("player_track_id") != anchor.get("player_track_id") or record.get("subject_confidence", 0) < .85:
                break
            point = [record.get("player_x"), record.get("player_bottom")]
        else:
            if not record.get("direct_ball"):
                break
            point = [record.get("ball_x"), record.get("ball_y")]
        if any(value is None or not np.isfinite(value) for value in point):
            break
        selected.append((record, point))
    return selected if len(selected) >= 3 else []


def jersey_signature(image, player):
    """Return a conservative shirt-colour histogram for one visible player."""
    height, width = image.shape[:2]
    x1, x2 = float(player.get("x1", 0)), float(player.get("x2", 0))
    y1, y2 = float(player.get("y1", 0)), float(player.get("y2", 0))
    if x2 <= x1 or y2 <= y1:
        return None
    # Central upper-body crop avoids grass, boots and most neighbouring players.
    left = int(np.clip((x1 + (x2-x1)*.16)*width, 0, width-1))
    right = int(np.clip((x2 - (x2-x1)*.16)*width, left+1, width))
    top = int(np.clip((y1 + (y2-y1)*.12)*height, 0, height-1))
    bottom = int(np.clip((y1 + (y2-y1)*.58)*height, top+1, height))
    patch = image[top:bottom, left:right]
    if patch.size < 90:
        return None
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    # Exclude pitch-green pixels that leak into small distant player boxes.
    green = cv2.inRange(hsv, np.array([28, 30, 20]), np.array([98, 255, 255]))
    mask = cv2.bitwise_not(green)
    if np.count_nonzero(mask) < 18:
        return None
    histogram = cv2.calcHist([hsv], [0, 1, 2], mask, [12, 5, 5], [0, 180, 0, 256, 0, 256])
    cv2.normalize(histogram, histogram, alpha=1.0, norm_type=cv2.NORM_L1)
    return histogram


def jersey_distance(a, b):
    if a is None or b is None:
        return 1.0
    return float(np.clip(cv2.compareHist(a, b, cv2.HISTCMP_BHATTACHARYYA), 0, 1))


def verified_pass_players(records, anchor):
    """Return the verified passer and receiver visible in the freeze frame."""
    points = drawing_points(records, anchor, "pass")
    if len(points) != 2:
        return None, None, []
    carrier_id = anchor.get("player_track_id")
    carrier = next((p for p in anchor.get("players", []) if p.get("trackId") == carrier_id), None)
    receiver_point = points[1][1]
    receiver = min(
        (p for p in anchor.get("players", []) if p.get("trackId") != carrier_id),
        key=lambda p: np.linalg.norm(np.subtract([p.get("cx", -2), p.get("y2", -2)], receiver_point)),
        default=None,
    )
    return carrier, receiver, points


def verified_pass_anchor(records, requested_time, maximum_distance=7.0):
    """Find the nearest safe pass handoff inside an already selected scene."""
    anchor = min(records, key=lambda record: abs(record["time"] - requested_time))
    points = drawing_points(records, anchor, "pass")
    if points:
        return anchor, points
    eligible = [(candidate, drawing_points(records, candidate, "pass")) for candidate in records]
    eligible = [(candidate, candidate_points) for candidate, candidate_points in eligible if candidate_points]
    phase_candidates = [item for item in eligible if any(
        record.get("action_phase") == "contact" and record.get("time", 0) > item[0]["time"]
        for record in records)]
    if not (phase_candidates or eligible):
        return None, []
    candidate, candidate_points = max(phase_candidates or eligible, key=lambda item: item[0]["time"])
    if abs(candidate["time"] - requested_time) > maximum_distance:
        return None, []
    return candidate, candidate_points


def same_team_support_players(image, anchor, carrier, receiver, maximum=2):
    """Select only high-confidence players whose shirts match both pass endpoints."""
    if carrier is None or receiver is None:
        return []
    carrier_signature = jersey_signature(image, carrier)
    receiver_signature = jersey_signature(image, receiver)
    endpoint_distance = jersey_distance(carrier_signature, receiver_signature)
    # If the verified pass endpoints do not visually confirm one kit, do not
    # guess teammate identities from proximity or formation shape.
    if endpoint_distance > .34:
        return []
    endpoint_ids = {carrier.get("trackId"), receiver.get("trackId")}
    ranked = []
    for player in anchor.get("players", []):
        if player.get("trackId") in endpoint_ids or player.get("trackId") is None:
            continue
        if player.get("confidence", 0) < .48 or player.get("pitchSupport", 0) < .08 or player.get("trackAge", 0) < 2:
            continue
        signature = jersey_signature(image, player)
        to_carrier = jersey_distance(signature, carrier_signature)
        to_receiver = jersey_distance(signature, receiver_signature)
        if max(to_carrier, to_receiver) > .30:
            continue
        foot = np.array([player.get("cx", -2), player.get("y2", -2)], dtype=float)
        if not np.isfinite(foot).all():
            continue
        carrier_foot = np.array([carrier["cx"], carrier["y2"]])
        receiver_foot = np.array([receiver["cx"], receiver["y2"]])
        spacing = min(np.linalg.norm(foot-carrier_foot), np.linalg.norm(foot-receiver_foot))
        if not .045 <= spacing <= .45:
            continue
        ranked.append(((to_carrier+to_receiver)/2 - player.get("confidence", 0)*.05, player))
    return [player for _, player in sorted(ranked, key=lambda item: item[0])[:maximum]]


def draw_foot_ring(canvas, point, stroke, color=TACTICAL_YELLOW):
    axes = (max(18, stroke*4), max(7, stroke+3))
    cv2.ellipse(canvas, point, axes, 0, 0, 360, SHADOW, stroke+4, cv2.LINE_AA)
    cv2.ellipse(canvas, point, axes, 0, 0, 360, color, stroke, cv2.LINE_AA)


def draw_tactical_line(canvas, start, end, stroke, color=TACTICAL_YELLOW):
    cv2.line(canvas, start, end, SHADOW, stroke+4, cv2.LINE_AA)
    cv2.line(canvas, start, end, color, stroke, cv2.LINE_AA)


def render_pass_stages(output, output_width, output_height, direct, nodes):
    """Create circles -> connector structure -> pass-arrow reveal stages."""
    stroke = max(4, int(round(max(output_width, output_height) / 360)))
    canvases = [np.zeros((output_height, output_width, 4), np.uint8) for _ in range(3)]
    for canvas in canvases:
        for point in nodes:
            draw_foot_ring(canvas, point, stroke)
    # Confirmed supporting structure: passer to each support, plus a support
    # chain when two teammates are safely identified. The direct pass itself is
    # reserved for the bright white arrow in stage three.
    support = nodes[2:]
    connectors = [(nodes[0], nodes[1])] + [(nodes[0], point) for point in support]
    if len(support) > 1:
        connectors.append((support[0], support[1]))
    for canvas in canvases[1:]:
        for start, end in connectors:
            draw_tactical_line(canvas, start, end, stroke)
    arrow_stroke = stroke + 2
    cv2.arrowedLine(canvases[2], direct[0], direct[1], SHADOW, arrow_stroke+5, cv2.LINE_AA, tipLength=.14)
    cv2.arrowedLine(canvases[2], direct[0], direct[1], PASS_WHITE, arrow_stroke, cv2.LINE_AA, tipLength=.14)
    destination = Path(output)
    stages = [destination.with_name(destination.stem + f"-stage-{index+1}" + destination.suffix) for index in range(3)]
    for path, canvas in zip(stages, canvases):
        cv2.imwrite(str(path), canvas)
    cv2.imwrite(str(destination), canvases[-1])
    return [str(path.resolve()) for path in stages], len(connectors)


def build_overlay(source, evidence, source_time, kind, output, output_width=1080, output_height=1920, native_landscape=False):
    records = evidence.get("sourceRecords", [])
    keyframes = evidence.get("keyframes", [])
    if not records or not keyframes:
        return {"approved": False, "reason": "missing_tracking"}
    time = source_time - evidence["sourceStartTime"]
    anchor = min(records, key=lambda r: abs(r["time"] - time))
    if abs(anchor["time"] - time) > .08:
        return {"approved": False, "reason": "no_observed_freeze_anchor"}
    points = drawing_points(records, anchor, kind)
    # Scene origin is the start of a buildup, not necessarily the handoff
    # frame. For pass analysis, move only within the already locked scene to
    # the nearest locally verified carrier-to-receiver transition.
    if kind == "pass" and not points:
        candidate, candidate_points = verified_pass_anchor(records, time)
        if candidate is not None:
            anchor, points = candidate, candidate_points
    if not points:
        return {"approved": False, "reason": "uncertain_trajectory"}
    cap = cv2.VideoCapture(source)
    def read(t):
        cap.set(cv2.CAP_PROP_POS_MSEC, (evidence["sourceStartTime"] + t) * 1000)
        ok, image = cap.read()
        return image if ok else None
    reference = read(anchor["time"])
    if reference is None:
        cap.release()
        return {"approved": False, "reason": "unreadable_frame"}
    h, w = reference.shape[:2]
    crop = [0, 0, 1, 1] if native_landscape else min(keyframes, key=lambda k: abs(k["time"] - time))["cropBox"]
    carrier = receiver = None
    supports = []
    node_entries = []
    if kind == "pass":
        carrier, receiver, points = verified_pass_players(records, anchor)
        if not points or carrier is None or receiver is None:
            cap.release()
            return {"approved": False, "reason": "uncertain_pass_endpoints"}
        carrier_signature = jersey_signature(reference, carrier)
        receiver_signature = jersey_signature(reference, receiver)
        # Track proximity can confuse an opponent for the intended receiver.
        # Both endpoints must independently expose a readable, matching kit in
        # the freeze frame before any circles or connector are allowed.
        if carrier_signature is None or receiver_signature is None:
            cap.release()
            return {"approved": False, "reason": "pass_endpoint_kits_unreadable"}
        if jersey_distance(carrier_signature, receiver_signature) > .30:
            cap.release()
            return {"approved": False, "reason": "pass_endpoints_not_same_team"}
        supports = same_team_support_players(reference, anchor, carrier, receiver)
        carrier_point = [carrier["cx"], carrier["y2"]] if carrier is not None else [anchor.get("player_x"), anchor.get("player_bottom")]
        receiver_point = [receiver["cx"], receiver["y2"]] if receiver is not None else points[1][1]
        if any(value is None for value in carrier_point):
            carrier_point = [anchor["ball_x"], anchor["ball_y"]]
        node_entries = [(anchor, carrier_point), (anchor, receiver_point)] + [
            (anchor, [player["cx"], player["y2"]]) for player in supports
        ]
    projection_entries = points + node_entries
    projected = []
    try:
        for record, point in projection_entries:
            current = read(record["time"])
            matrix = np.eye(3) if record is anchor else register_frame(reference, current) if current is not None else None
            if matrix is None:
                return {"approved": False, "reason": "uncertain_camera_registration"}
            xy = cv2.perspectiveTransform(np.float32([[[point[0]*w, point[1]*h]]]), matrix)[0, 0]
            x = (xy[0]/w - crop[0]) / (crop[2]-crop[0])
            y = (xy[1]/h - crop[1]) / (crop[3]-crop[1])
            if not (.04 < x < .96 and .08 < y < .92):
                return {"approved": False, "reason": "drawing_outside_safe_crop"}
            projected.append((int(x*output_width), int(y*output_height)))
    finally:
        cap.release()
    # For a pass, the first two projections are always its verified direct
    # endpoints. Supporting nodes follow them and must not affect validation.
    movement_start = projected[2] if kind == "pass" else projected[0]
    movement_end = projected[3] if kind == "pass" else projected[-1]
    if np.linalg.norm(np.subtract(movement_end, movement_start)) < max(35, output_width*.025):
        return {"approved": False, "reason": "movement_too_small"}
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    if kind == "pass":
        nodes = projected[2:]
        direct = nodes[:2]
        stages, connector_count = render_pass_stages(output, output_width, output_height, direct, nodes)
        verified_source_time = evidence["sourceStartTime"] + anchor["time"]
        return {"approved": True, "kind": kind, "sourceTime": verified_source_time, "observations": len(points),
                "supportPlayers": len(supports), "connectorCount": connector_count,
                "stages": stages, "path": str(Path(output).resolve())}
    canvas = np.zeros((output_height,output_width,4), np.uint8)
    stroke = max(6, int(round(max(output_width, output_height) / 240)))
    color = (80,220,255,255) if kind in ("ball", "pass") else (255,220,80,255)
    if kind in ("ball", "pass"):
        cv2.polylines(canvas, [np.int32(projected)], False, color, stroke, cv2.LINE_AA)
    else:
        for a, b in zip(projected[::2], projected[1::2]):
            cv2.line(canvas, a, b, color, stroke, cv2.LINE_AA)
    cv2.arrowedLine(canvas, projected[-2], projected[-1], color, stroke, cv2.LINE_AA, tipLength=.35)
    cv2.circle(canvas, projected[0], max(16, stroke*2), max(4, stroke//2), cv2.LINE_AA)
    cv2.imwrite(output, canvas)
    return {"approved":True,"kind":kind,"sourceTime":source_time,"observations":len(points),"path":str(Path(output).resolve())}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--time", type=float, required=True)
    parser.add_argument("--kind", choices=["ball","run","pass"], required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--native-landscape", action="store_true")
    args = parser.parse_args()
    result = build_overlay(args.source, json.loads(Path(args.evidence).read_text()), args.time, args.kind, args.output,
        args.width, args.height, args.native_landscape)
    print(json.dumps(result))

"""Measure the actual portrait crop at each action phase, not source detections."""


def phase_quality(keyframes, contact_time):
    def summarize(frames):
        count = len(frames)
        def ratio(predicate):
            return round(sum(predicate(f) for f in frames) / max(1, count), 4)
        return {
            "samples": count,
            "directBallCoverage": ratio(lambda f: bool(f["directBall"] and f["ballInFrame"])),
            "ballCoverage": ratio(lambda f: bool(f["ballInFrame"])),
            "jointCoverage": ratio(lambda f: bool(f["jointFit"])),
            "directJointCoverage": ratio(lambda f: bool(f["directBall"] and f["jointFit"])),
            "payoffCoverage": ratio(lambda f: bool(f["payoffRegionInFrame"])),
        }
    phases = {phase: summarize([f for f in keyframes if f["actionPhase"] == phase])
              for phase in ("setup", "flight", "payoff")}
    # Contact is an instant; check neighboring samples rather than an empty
    # interval between two semantic timestamps.
    phases["contact"] = summarize([f for f in keyframes
        if contact_time - .30 <= f["time"] <= contact_time + .25])
    return {"version": 1, **phases}

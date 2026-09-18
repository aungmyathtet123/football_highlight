import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-processor"))
from phase_quality import phase_quality


class PhaseQualityTests(unittest.TestCase):
    def test_ball_detected_outside_crop_is_not_visible_evidence(self):
        frames = [dict(time=.5,actionPhase="flight",directBall=True,ballInFrame=False,
                       jointFit=False,payoffRegionInFrame=False)]
        self.assertEqual(phase_quality(frames,0)["flight"]["directBallCoverage"],0)

    def test_contact_window_uses_nearby_samples_and_prediction_is_not_direct(self):
        frames = [dict(time=t,actionPhase="setup",directBall=t<1,ballInFrame=True,
                       jointFit=True,payoffRegionInFrame=False) for t in (.8,.9,1,1.1,1.2)]
        quality = phase_quality(frames,1)
        self.assertEqual(quality["contact"]["samples"],5)
        self.assertEqual(quality["contact"]["directJointCoverage"],.4)
        self.assertEqual(quality["payoff"]["samples"],0)

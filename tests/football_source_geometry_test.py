import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-processor"))
from football_action_phase import action_clock
from football_source_geometry import goalkeeper_targets, on_target_keeper_handoff


def frame(number, time, x=None, cut=False):
    people = [] if x is None else [dict(role="goalkeeper", cx=x,
        confidence=.8, pitchSupport=.3)]
    return dict(frame=number, time=time, cut=cut, people=people)


class SourceGeometryTests(unittest.TestCase):
    def test_collapsed_saved_clock_recovers_action_phases(self):
        contact, flight, handoff, payoff = action_clock(dict(
            contactTime=382.503, flightStartTime=382.503,
            handoffTime=382.503, payoffStartTime=382.503), 382.5, 387.354)
        self.assertGreater(contact, 1.0)
        self.assertGreater(flight, contact)
        self.assertGreater(payoff, flight)

    def test_valid_cross_before_final_contact_is_preserved(self):
        self.assertEqual(action_clock(dict(contactTime=14, flightStartTime=12,
            handoffTime=13, payoffStartTime=15), 10, 16), (4, 2, 3, 5))

    def test_observed_keeper_follows_broadcast_pan(self):
        frames = [frame(0, 0, .18), frame(1, .2, .20), frame(2, .4, .22),
                  frame(3, .8), frame(4, 1.2, .35), frame(5, 1.4, .40)]
        targets = goalkeeper_targets(frames, "left")
        self.assertAlmostEqual(targets[3], .285, places=3)
        self.assertAlmostEqual(targets[5], .40)

    def test_isolated_keeper_or_source_cut_does_not_invent_destination(self):
        self.assertEqual(goalkeeper_targets([frame(0, 0, .2), frame(1, .2)], "left"), {})
        frames = [frame(0, 0, .2), frame(1, .2, .21), frame(2, .4, .22),
                  frame(3, .5, None, cut=True), frame(4, .7)]
        self.assertNotIn(3, goalkeeper_targets(frames, "left"))

    def test_late_keeper_does_not_redirect_unseen_opening(self):
        frames = [frame(0, 0), frame(1, .2), frame(2, .4, .2),
                  frame(3, .6, .21), frame(4, .8, .22)]
        self.assertNotIn(0, goalkeeper_targets(frames, "left"))

    def test_on_target_result_hands_camera_to_observed_keeper_only_after_ball_link(self):
        self.assertFalse(on_target_keeper_handoff("save", "setup", 1.0, .7, .2, .22, .32))
        self.assertFalse(on_target_keeper_handoff("save", "payoff", 1.0, .7, .2, .8, .32))
        self.assertFalse(on_target_keeper_handoff("shot_off_target", "payoff", 1.0, .7, .2, .22, .32))
        self.assertFalse(on_target_keeper_handoff("save", "flight", .8, .7, .2, .22, .32))
        self.assertTrue(on_target_keeper_handoff("save", "flight", 1.0, .7, .2, .22, .32))
        self.assertTrue(on_target_keeper_handoff("shot_on_target", "payoff", 1.5, .7, .2, None, .32,
                                                 recently_linked=True))


if __name__ == "__main__":
    unittest.main()

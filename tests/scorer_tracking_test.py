import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-processor"))
from scorer_tracking import select_scorer_track_id, select_stable_action_track_id


class ScorerTrackingTest(unittest.TestCase):
    def test_checks_every_player_at_contact_not_only_locked_defender(self):
        records = [{"time": 2.60, "direct_ball": True, "ball_x": .656, "ball_y": .574,
                    "player_track_id": 3, "joint_fit": True, "subject_confidence": .74,
                    "players": [
                        {"trackId": 3, "cx": .561, "y2": .666, "confidence": .74, "pitchSupport": 1, "trackAge": 27},
                        {"trackId": 39, "cx": .642, "y2": .582, "confidence": .64, "pitchSupport": 1, "trackAge": 18},
                    ]}]
        self.assertEqual(select_scorer_track_id(records, 2.60), 39)

    def test_contact_owner_beats_longer_nearby_defender_track(self):
        records = [
            {"time": 2.12, "player_track_id": 7, "direct_ball": True, "joint_fit": True,
             "subject_confidence": .8, "possession": False},
            {"time": 2.20, "player_track_id": 7, "direct_ball": True, "joint_fit": True,
             "subject_confidence": .8, "possession": False},
            {"time": 2.44, "player_track_id": 81, "direct_ball": True, "joint_fit": True,
             "subject_confidence": .82, "possession": True},
            {"time": 2.52, "player_track_id": 81, "direct_ball": True, "joint_fit": True,
             "subject_confidence": .80, "possession": True},
        ]
        self.assertEqual(select_scorer_track_id(records, 2.52), 81)

    def test_stable_action_subject_requires_continuous_identity(self):
        records = [{"time": index / 10, "player_track_id": 248, "direct_ball": True,
                    "joint_fit": True, "subject_confidence": .72} for index in range(10)]
        self.assertEqual(select_stable_action_track_id(records, 0, .9), 248)

    def test_stable_action_subject_rejects_identity_switches(self):
        records = [{"time": index / 10, "player_track_id": 10 if index < 5 else 20,
                    "direct_ball": True, "joint_fit": True, "subject_confidence": .8}
                   for index in range(10)]
        self.assertIsNone(select_stable_action_track_id(records, 0, .9))

    def test_requires_direct_joint_contact_evidence(self):
        records = [{"time": 2.5, "player_track_id": 4, "direct_ball": False,
                    "joint_fit": True, "subject_confidence": .9, "possession": True}]
        self.assertIsNone(select_scorer_track_id(records, 2.52))


if __name__ == "__main__":
    unittest.main()

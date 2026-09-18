import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-processor"))
from tracking_motion import active_joint_fit_in_crop, camera_ownership_phase, constrained_camera, framing_bounds, vertical_framing_bounds, flight_target, visible_in_crop, possession_handoff, observed_payoff_box, goal_outcome_subject, goal_outcome_target, reconcile_goal_destination


class CameraTests(unittest.TestCase):
    def test_observed_flight_flags_but_does_not_override_verified_goal_side(self):
        observations = [
            {"frame": index, "time": time}
            for index, time in enumerate([9.7, 9.85, 10.0, 10.35, 10.5, 10.65, 10.8])
        ]
        xs = [.52, .50, .49, .44, .40, .36, .33]
        path = {index: {"cx": x, "cy": .5} for index, x in enumerate(xs)}
        focus, box, reason = reconcile_goal_destination(
            observations, path, 0, 10, 10.8, .80, [.65, .35, .90, .65]
        )
        self.assertEqual(focus, .80)
        self.assertEqual(box, [.65, .35, .90, .65])
        self.assertEqual(reason, "observed_ball_path_conflicts_with_verified_goal_side")

    def test_observed_flight_keeps_a_consistent_semantic_goal_side(self):
        observations = [
            {"frame": index, "time": time}
            for index, time in enumerate([9.7, 9.85, 10.0, 10.35, 10.5, 10.65, 10.8])
        ]
        path = {index: {"cx": x, "cy": .5} for index, x in enumerate([.48, .49, .50, .56, .61, .66, .70])}
        focus, box, reason = reconcile_goal_destination(
            observations, path, 0, 10, 10.8, .80, [.65, .35, .90, .65]
        )
        self.assertEqual(focus, .80)
        self.assertEqual(box, [.65, .35, .90, .65])
        self.assertIsNone(reason)

    def test_prediction_cannot_force_an_abrupt_crop_move(self):
        record=self.record(1,.1)
        record["direct_ball"]=False
        self.assertEqual(framing_bounds(record,.3164),(.1582,.8418))

    def test_trusted_trajectory_guidance_remains_a_hard_camera_constraint(self):
        record=self.record(1,.62)
        record.update(direct_ball=False,ball_guidance=True,player_x=.3,player_x1=.28,player_x2=.32)
        low,high=framing_bounds(record,.3164)
        self.assertTrue(visible_in_crop(.62,.5,low,.5,.3164,1))
        self.assertTrue(visible_in_crop(.62,.5,high,.5,.3164,1))

    def test_receiver_evidence_overrides_old_owner_preference(self):
        old=dict(cx=.2,y2=.6,trackId=1)
        receiver=dict(cx=.5,y2=.6,trackId=2)
        transfer=possession_handoff([old,receiver],(.51,.6),old,2,2)
        self.assertEqual(transfer,(receiver,3))
        self.assertIsNone(possession_handoff([old,receiver],(.21,.6),old,2,2))

    def record(self, t, ball, player=0.3, cut=False):
        return dict(time=t, ball_x=ball, player_x=player,
                    player_x1=player - .02, player_x2=player + .02, scene_cut=cut)

    def test_pass_leaves_passer_and_follows_ball(self):
        records = [self.record(i / 10, .3 + i * .006) for i in range(81)]
        camera = constrained_camera([record["ball_x"] for record in records], records, .3164)
        for center, record in zip(camera, records):
            self.assertTrue(visible_in_crop(record["ball_x"], .5, center, .5, .3164, 1))
        self.assertGreater(camera[-1], .63)

    def test_ball_targets_are_not_replaced_by_one_static_scene_anchor(self):
        records = [self.record(i / 10, .30 + i * .005, .29 + i * .005) for i in range(60)]
        for record in records:
            record.update(action_phase="setup", direct_ball=True, ball_guidance=True)
        targets = [record["ball_x"] for record in records]
        camera = constrained_camera(targets, records, .3164)
        self.assertLess(abs(camera[-1] - records[-1]["ball_x"]), .09)
        self.assertGreater(camera[-1] - camera[0], .20)

    def test_joint_pair_is_preserved_when_it_fits(self):
        low, high = framing_bounds(self.record(0, .41), .3164)
        for center in (low, high):
            self.assertTrue(visible_in_crop(.28, .5, center, .5, .3164, 1))
            self.assertTrue(visible_in_crop(.41, .5, center, .5, .3164, 1))

    def test_setup_keeps_complete_player_and_ball_inside_a_safe_portrait_zone(self):
        record = self.record(0, .50, .35)
        record.update(action_phase="setup", player_x1=.31, player_x2=.39,
                      player_top=.28, player_bottom=.82, ball_y=.78)
        low, high = framing_bounds(record, .3164)
        safe = min(.035, .3164 * .11)
        for center in (low, high):
            self.assertTrue(visible_in_crop(.50, .78, center, .5, .3164, 1, safe))
            self.assertTrue(visible_in_crop(.31, .28, center, .5, .3164, 1, safe))
            self.assertTrue(visible_in_crop(.39, .82, center, .5, .3164, 1, safe))

    def test_ball_stays_in_central_half_when_player_pair_allows_it(self):
        record = self.record(0, .50, .39)
        record.update(action_phase="setup", direct_ball=True, ball_guidance=True,
                      player_x1=.35, player_x2=.43, ball_y=.78)
        low, high = framing_bounds(record, .3164)
        for center in (low, high):
            output_x = .5 + (.50 - center) / .3164
            self.assertGreaterEqual(output_x, .25)
            self.assertLessEqual(output_x, .75)
            self.assertTrue(visible_in_crop(.35, .5, center, .5, .3164, 1))
            self.assertTrue(visible_in_crop(.43, .5, center, .5, .3164, 1))

    def test_flight_ball_stays_in_central_half_of_portrait(self):
        record = self.record(0, .70, .20)
        record.update(action_phase="flight", direct_ball=True, ball_guidance=True)
        low, high = framing_bounds(record, .3164)
        for center in (low, high):
            output_x = .5 + (.70 - center) / .3164
            self.assertGreaterEqual(output_x, .25)
            self.assertLessEqual(output_x, .75)

    def test_contact_pair_does_not_drop_player_beyond_old_owner_threshold(self):
        record = self.record(0, .50, .35)
        record.update(action_phase="contact", player_x1=.31, player_x2=.39,
                      player_top=.28, player_bottom=.82, ball_y=.78)
        center = sum(framing_bounds(record, .3164)) / 2
        self.assertTrue(active_joint_fit_in_crop(record, center, .5, .3164, 1))

    def test_short_ball_occlusion_keeps_complete_active_player_constrained(self):
        record = self.record(0, None, .71)
        record.update(action_phase="setup", player_x1=.67, player_x2=.75,
                      player_top=.24, player_bottom=.84, ball_y=None,
                      subject_recently_ball_linked=True)
        low, high = framing_bounds(record, .3164)
        for center in (low, high):
            self.assertTrue(visible_in_crop(.67, .24, center, .5, .3164, 1))
            self.assertTrue(visible_in_crop(.75, .84, center, .5, .3164, 1))

    def test_unrelated_player_during_long_ball_loss_cannot_redirect_crop(self):
        record = self.record(0, None, .12)
        record.update(action_phase="setup", player_x1=.08, player_x2=.16,
                      player_top=.24, player_bottom=.84, ball_y=None,
                      subject_recently_ball_linked=False)
        self.assertEqual(framing_bounds(record, .3164), (.1582, .8418))

    def test_zoomed_crop_protects_full_player_and_ball_vertically(self):
        record = self.record(0, .5, .5)
        record.update(action_phase="contact", ball_y=.82, player_top=.20, player_bottom=.86,
                      direct_ball=True, ball_guidance=True)
        low, high = vertical_framing_bounds(record, .80)
        for center in (low, high):
            self.assertTrue(visible_in_crop(.5, .20, .5, center, 1, .80))
            self.assertTrue(visible_in_crop(.5, .86, .5, center, 1, .80))

    def test_camera_path_obeys_speed_and_acceleration_when_feasible(self):
        records = [self.record(i / 10, .40 + i * .002, .40 + i * .002) for i in range(40)]
        for record in records:
            record.update(action_phase="setup", direct_ball=True, ball_guidance=True)
        camera = constrained_camera([record["ball_x"] for record in records], records, .3164)
        speed = np.diff(camera) / .1
        acceleration = np.diff(speed) / .1
        self.assertLessEqual(np.max(np.abs(speed)), .321)
        self.assertLessEqual(np.max(np.abs(acceleration)), .751)

    def test_actual_sample_interval_changes_speed_budget(self):
        for fps in (8, 10, 20):
            records = [self.record(i / fps, .3 + .06 * i / fps) for i in range(fps * 6)]
            for record in records:
                record.update(action_phase="flight", direct_ball=True, ball_guidance=True)
            camera = constrained_camera([.3] * len(records), records, .3164)
            self.assertLess(max(abs(b - a) * fps for a, b in zip(camera, camera[1:])), .33)

    def test_source_cut_does_not_drag_old_camera(self):
        records = [self.record(0, .2), self.record(.1, .8, .8, True)]
        camera = constrained_camera([.2, .8], records, .3164)
        self.assertLess(camera[0], .3)
        self.assertGreater(camera[1], .7)

    def test_contact_finishes_before_ball_owned_camera_pan_begins(self):
        records = [
            dict(self.record(0, .24, .24), action_phase="setup", direct_ball=True, ball_guidance=True),
            dict(self.record(.1, .25, .24), action_phase="contact", direct_ball=True, ball_guidance=True),
            dict(self.record(.2, .31, .24), action_phase="flight", direct_ball=True, ball_guidance=True),
            dict(self.record(.3, .35, .24), action_phase="flight", direct_ball=True, ball_guidance=True),
            dict(self.record(.4, .39, .24), action_phase="flight", direct_ball=True, ball_guidance=True),
        ]
        camera = constrained_camera([.24, .25, .31, .35, .39], records, .3164)
        self.assertEqual(camera_ownership_phase(records[1]), "carrier")
        self.assertEqual(camera_ownership_phase(records[2]), "ball")
        self.assertLess(camera[1], .29)
        self.assertLessEqual(abs(camera[2] - camera[1]), .04)

    def test_early_pass_phase_cannot_override_decisive_contact_ownership(self):
        record = dict(self.record(1, .42, .38), action_phase="flight", camera_owner="carrier")
        self.assertEqual(camera_ownership_phase(record), "carrier")

    def test_phase_framing_follows_active_player_not_annotation_identity(self):
        record = self.record(1, .52)
        record.update(ball_x=.54, ball_y=.55, player_x1=.49, player_x2=.53,
                      player_top=.35, player_bottom=.75, joint_fit=True)
        self.assertTrue(active_joint_fit_in_crop(record, .52, .5, .3164, 1))
        record["player_x1"], record["player_x2"] = .05, .10
        self.assertFalse(active_joint_fit_in_crop(record, .52, .5, .3164, 1))

    def test_rendered_visibility_overrules_pre_crop_safety_margin(self):
        record = self.record(1, .52)
        record.update(ball_x=.63, ball_y=.55, player_x1=.40, player_x2=.52,
                      player_top=.30, player_bottom=.78, joint_fit=False)
        self.assertTrue(active_joint_fit_in_crop(record, .52, .5, .3164, 1))

    def test_no_prediction_can_claim_observed_visibility(self):
        self.assertFalse(visible_in_crop(None, .5, .5, .5, .3164, 1))

    def test_flight_target_does_not_average_with_distant_passer(self):
        player = dict(cx=.2, x1=.18, x2=.22)
        self.assertGreaterEqual(flight_target(.7, player, .1, .3164, .2), .7)

    def test_observed_goal_area_overrules_false_ball_elsewhere(self):
        record = self.record(1, .2)
        record["payoff_box"] = [.65, .3, .85, .7]
        low, high = framing_bounds(record, .3164)
        self.assertGreater(low, .69)
        self.assertTrue(visible_in_crop(.85,.5,high,.5,.3164,1))

    def test_goal_outcome_framing_keeps_goal_anchor_and_goal_side_player(self):
        keeper = dict(x1=.59, x2=.63, y1=.38, y2=.66, cx=.61, cy=.52,
                      pitchSupport=.25, confidence=.9, trackAge=8)
        record = self.record(1, None)
        record.update(payoff_box=[.65,.35,.88,.8], goal_focus_x=.765,
                      outcome_subject=keeper)
        low, high = framing_bounds(record, .3164)
        for center in (low, high):
            self.assertTrue(visible_in_crop(.765,.55,center,.5,.3164,1))
            self.assertTrue(visible_in_crop(keeper["cx"],.52,center,.5,.3164,1))

    def test_goal_outcome_subject_ignores_crowd_and_chooses_pitch_context(self):
        crowd = dict(x1=.73,x2=.77,y1=.05,y2=.20,cx=.75,cy=.12,pitchSupport=0,
                     confidence=.99,trackAge=10)
        keeper = dict(x1=.60,x2=.64,y1=.38,y2=.68,cx=.62,cy=.53,pitchSupport=.2,
                      confidence=.8,trackAge=7)
        chosen = goal_outcome_subject([crowd,keeper],[.65,.35,.88,.8],.765,(.69,.54))
        self.assertIs(chosen, keeper)

    def test_goal_outcome_subject_never_selects_unrelated_defender(self):
        defender = dict(x1=.58,x2=.64,y1=.30,y2=.70,cx=.61,cy=.50,
                        pitchSupport=.25,confidence=.95,trackAge=10)
        self.assertIsNone(goal_outcome_subject([defender],[.65,.35,.88,.8],.765,None))
        self.assertIsNone(goal_outcome_subject([defender],[.65,.35,.88,.8],.765,(.82,.48)))

    def test_flight_target_leads_ball_toward_verified_goal_context(self):
        keeper = dict(cx=.62,cy=.53)
        x, y = goal_outcome_target([.65,.35,.88,.8],.765,keeper,(.68,.5),"flight",.4)
        self.assertGreater(x,.66)
        self.assertLess(x,.765)
        self.assertGreater(y,.49)

    def test_goal_payoff_box_cannot_contradict_goal_side(self):
        moment = {"eventType": "goal", "trackingBrief": {
            "goalFocusX": .85,
            "payoffEvidence": {"verified": True, "eventType": "goal", "startTime": 4, "endTime": 5,
                               "targetBox": [.42, .60, .62, .88]},
        }}
        self.assertIsNone(observed_payoff_box(moment, 4.5))
        moment["trackingBrief"]["payoffEvidence"]["targetBox"] = [.72, .35, .91, .72]
        self.assertEqual(observed_payoff_box(moment, 4.5), [.72, .35, .91, .72])

    def test_verified_goal_payoff_remains_locked_until_incident_end(self):
        moment = {"eventType": "goal", "endTime": 9, "trackingBrief": {
            "goalFocusX": .82,
            "payoffEvidence": {"verified": True, "eventType": "goal", "startTime": 4, "endTime": 6,
                               "targetBox": [.72, .35, .91, .72]},
        }}
        self.assertEqual(observed_payoff_box(moment, 8.5), [.72, .35, .91, .72])
        self.assertIsNone(observed_payoff_box(moment, 9.1))

    def test_non_goal_payoff_does_not_outlive_observed_window(self):
        moment = {"eventType": "save", "endTime": 9, "trackingBrief": {
            "payoffEvidence": {"verified": True, "eventType": "save", "startTime": 4, "endTime": 6,
                               "targetBox": [.72, .35, .91, .72]},
        }}
        self.assertIsNone(observed_payoff_box(moment, 8.5))


if __name__ == "__main__":
    unittest.main()

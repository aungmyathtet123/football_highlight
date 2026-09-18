import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-processor"))
from ball_trajectory import choose_trajectory, interpolate_observation_gaps, trajectory_camera_guidance


def ball(x, confidence=.6):
    return dict(cx=x, cy=.6, x1=x-.004, x2=x+.004, y1=.596, y2=.604,
                confidence=confidence, pitchSupport=.8)


class TrajectoryTests(unittest.TestCase):
    def test_gap_guidance_requires_both_endpoints_and_never_crosses_a_cut(self):
        frames=[dict(frame=i,time=i*.1,cut=False) for i in range(5)]
        path={0:ball(.2),1:None,2:ball(.3),3:None,4:None}
        self.assertAlmostEqual(interpolate_observation_gaps(frames,path)[1][0],.25)
        self.assertNotIn(3,interpolate_observation_gaps(frames,path))
        frames[1]["cut"]=True
        self.assertEqual(interpolate_observation_gaps(frames,path),{})

    def test_camera_guidance_bridges_short_occlusion_without_claiming_detection(self):
        frames=[dict(frame=i,time=i*.1,cut=False) for i in range(8)]
        path={0:None,1:ball(.2),2:None,3:None,4:None,5:ball(.5),6:None,7:None}
        guidance=trajectory_camera_guidance(frames,path)
        self.assertEqual(guidance[0],(.2,.6))
        self.assertAlmostEqual(guidance[3][0],.35)
        self.assertEqual(guidance[7],(.5,.6))

    def test_camera_prepositions_before_first_coherent_setup_detection(self):
        frames=[dict(frame=i,time=i*.5,cut=False) for i in range(8)]
        path={i:None for i in range(8)}
        path[5]=ball(.78)
        guidance=trajectory_camera_guidance(frames,path,opening_hold=3.0)
        self.assertEqual(guidance[0],(.78,.6))
        self.assertEqual(guidance[4],(.78,.6))

    def test_payoff_constraint_selects_an_alternative_before_association(self):
        frames = [dict(frame=i,time=i*.1,people=[],balls=[ball(.2,.9),ball(.7,.6)],
                       payoff_box=[.6,.4,.8,.8]) for i in range(8)]
        self.assertTrue(all(b and b["cx"] == .7 for b in choose_trajectory(frames,.3164).values()))

    def test_airborne_ball_does_not_require_grass_or_a_nearby_player(self):
        airborne = {**ball(.6), "pitchSupport":0}
        frame = dict(frame=0,time=0,people=[],balls=[airborne],airborne=True)
        self.assertIsNotNone(choose_trajectory([frame],.3164)[0])
        self.assertIsNone(choose_trajectory([{**frame,"airborne":False}],.3164)[0])

    def test_future_evidence_avoids_temporary_distant_false_ball(self):
        frames=[dict(frame=i,time=i*.1,people=[],balls=[ball(.2+i*.003)]+([ball(.8,.8)] if i<3 else [])) for i in range(20)]
        path=choose_trajectory(frames,.3164)
        self.assertLess(path[0]["cx"],.3)
        self.assertLess(max(b["cx"] for b in path.values() if b),.3)

    def test_opening_focus_prior_rejects_a_coherent_distant_boot_path(self):
        frames=[dict(frame=i,time=i*.1,people=[],balls=[ball(.18,.9),ball(.55,.65)]) for i in range(10)]
        path=choose_trajectory(frames,.3164,initial_focus_x=.55)
        self.assertTrue(all(item and item["cx"] == .55 for item in path.values()))

    def test_verified_attack_route_reacquires_real_ball_during_flight(self):
        frames=[]
        for i in range(28):
            real=ball(.67 + i*.006, .08)
            boot=ball(.34 - i*.004, .88)
            people=[dict(cx=real["cx"],y2=real["cy"],pitchSupport=1),
                    dict(cx=boot["cx"],y2=boot["cy"],pitchSupport=1)]
            frames.append(dict(frame=i,time=i*.1,people=people,balls=[boot,real]))
        path=choose_trajectory(frames,.3164,initial_focus_x=.34,
            attack_direction="right",contact_time=1.4,goal_focus_x=.86,goal_focus_y=.55)
        observed=[item for item in path.values() if item]
        self.assertGreater(len(observed), 15)
        self.assertTrue(all(item and item["cx"] > .75 for item in list(path.values())[-7:]))

    def test_pre_contact_goal_prior_cannot_replace_real_ball_with_goal_side_boot(self):
        frames=[]
        for i in range(8):
            real={**ball(.390+i*.001,.84), "cy":.43, "y1":.426, "y2":.434}
            boot={**ball(.550+i*.0005,.66), "cy":.46, "y1":.456, "y2":.464}
            people=[dict(cx=real["cx"],y2=real["cy"],pitchSupport=1),
                    dict(cx=boot["cx"],y2=boot["cy"],pitchSupport=1)]
            frames.append(dict(frame=i,time=413.1+i*.1,people=people,balls=[boot,real]))
        path=choose_trajectory(frames,.3164,attack_direction="right",
            contact_time=413.9,goal_focus_x=.785,goal_focus_y=.60)
        observed=[item for item in path.values() if item]
        self.assertEqual(len(observed),len(frames))
        self.assertTrue(all(item["cx"] < .45 for item in observed))

    def test_attack_route_does_not_invent_missing_ball_observations(self):
        frames=[dict(frame=i,time=i*.1,people=[],balls=[] if i==3 else [ball(.7+i*.005,.08)])
                for i in range(7)]
        path=choose_trajectory(frames,.3164,attack_direction="right",
            contact_time=.7,goal_focus_x=.86)
        self.assertIsNone(path[3])

    def test_goal_lane_rejects_foreground_boot_during_verified_flight(self):
        frames=[]
        for i in range(12):
            # A weak but genuine detector response must beat a stronger boot
            # once verified post-contact flight begins.
            real={**ball(.68+i*.008,.22), "cy":.49, "y1":.486, "y2":.494}
            foreground={**ball(.63+i*.004,.65), "cy":.75, "y1":.746, "y2":.754}
            people=[dict(cx=real["cx"],y2=real["cy"],pitchSupport=1),
                    dict(cx=foreground["cx"],y2=foreground["cy"],pitchSupport=1)]
            frames.append(dict(frame=i,time=i*.2,people=people,balls=[foreground,real]))
        path=choose_trajectory(frames,.3164,attack_direction="right",
            contact_time=1.2,goal_focus_x=.86,goal_focus_y=.56)
        observed=[item for item in path.values() if item]
        self.assertGreater(len(observed), 6)
        self.assertTrue(all(item and item["cy"] < .6 for item in list(path.values())[-5:]))

    def test_missing_observation_is_not_fabricated(self):
        frames=[dict(frame=i,time=i*.1,people=[],balls=[] if i==2 else [ball(.2+i*.003)]) for i in range(5)]
        self.assertIsNone(choose_trajectory(frames,.3164)[2])

    def test_source_cut_resets_trajectory(self):
        frames=[dict(frame=i,time=i*.1,people=[],cut=i==3,balls=[ball(.2 if i<3 else .8)]) for i in range(6)]
        path=choose_trajectory(frames,.3164)
        self.assertEqual(path[3]["cx"],.8)


if __name__ == "__main__":
    unittest.main()

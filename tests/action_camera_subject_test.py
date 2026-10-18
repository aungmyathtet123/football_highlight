import importlib.util
import sys
import unittest
from pathlib import Path
root=Path(__file__).resolve().parents[1]/'local-processor'
sys.path.insert(0,str(root))
spec=importlib.util.spec_from_file_location('action_camera_subject',root/'action-camera-subject.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
from tracking_motion import framing_bounds,constrained_camera


class ActionCameraSubjectTests(unittest.TestCase):
    def test_reaction_uses_measured_body_without_chasing_an_unrelated_ball(self):
        records=[dict(time=i/30,scene_cut=i==0,action_phase='setup',direct_ball=True,ball_x=.9,
            camera_target_x=.9,observed_closeup_box=[.25+i*.001,.1,.55+i*.001,.95]) for i in range(30)]
        module.actor_targets(records,'reaction',1)
        self.assertEqual(records[0]['camera_target_x'],.4)
        self.assertEqual(records[0]['ball_x'],.9)
        path=constrained_camera([r['camera_target_x'] for r in records],records,.3164,max_speed=.22)
        self.assertLess(max(abs(path[i]-path[i-1])*30 for i in range(1,len(path))),.352)
        self.assertTrue(all(abs(x-.4)<.15 for x in path))

    def test_referee_handoff_keeps_the_challenge_and_allows_a_pan_before_the_signal(self):
        referee={'role':'referee','confidence':.9,'trackId':8,'x1':.2,'x2':.23,'y1':.4,'y2':.6}
        records=[dict(time=t,scene_cut=False,camera_target_x=.7,direct_ball=True,ball_x=.7,
            camera_owner='ball',players=[referee]) for t in [4.9,5.3,5.6,6,7]]
        module.actor_targets(records,'referee',5.25,7.083)
        self.assertEqual(records[1]['camera_owner'],'ball')
        self.assertEqual(records[2]['camera_owner'],'decision_handoff')
        self.assertEqual(framing_bounds(records[2],.3164),(.1582,.8418))
        self.assertEqual(records[-1]['camera_owner'],'referee')
        self.assertEqual(records[-1]['framing_subject_box'],[.2,.4,.23,.6])

    def test_a_missing_official_never_gets_invented_coordinates(self):
        records=[dict(time=7,players=[],camera_target_x=.5)]
        module.actor_targets(records,'referee',5,7)
        self.assertIsNone(records[0]['framing_subject_box'])
        self.assertEqual(records[0]['camera_target_x'],.5)


if __name__=='__main__':unittest.main()

import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local-processor'))
from football_ball_motion import coherent_motion_path, wide_motion_view
from ball_trajectory import choose_trajectory


class BallMotionTests(unittest.TestCase):
    def test_closeup_replay_cannot_use_tiny_wide_shot_motion_rules(self):
        def people(height):
            return [dict(y1=.3,y2=.3+height,confidence=.8,pitchSupport=.8) for _ in range(8)]
        self.assertTrue(wide_motion_view(people(.10)))
        self.assertFalse(wide_motion_view(people(.33)))

    def test_fast_ball_survives_stronger_slow_boot_and_detection_gaps(self):
        frames=[]
        for index in range(16):
            balls=[] if index in {4,9} else [dict(frame=index,cx=.75-index*.018,cy=.4-index*.001,
                x1=.746-index*.018,x2=.754-index*.018,y1=.396-index*.001,y2=.404-index*.001,
                confidence=.55,pitchSupport=.9)]
            frames.append(dict(time=index/30,balls=balls))
        path=coherent_motion_path(frames)
        self.assertGreaterEqual(len(path),12)
        self.assertNotIn(4,path)
        self.assertNotIn(9,path)
        observed=[]
        for index,frame in enumerate(frames):
            boot=dict(cx=.75+index*.001,cy=.6,x1=.746+index*.001,x2=.754+index*.001,
                y1=.596,y2=.604,confidence=.95,pitchSupport=.9)
            candidates=[boot,*([path[index]] if index in path else [])]
            observed.append(dict(frame=index,time=frame['time'],balls=candidates,people=[]))
        associated=choose_trajectory(observed,.3164)
        tail=[ball for ball in list(associated.values())[-5:] if ball]
        self.assertTrue(tail)
        self.assertTrue(all(ball.get('motionTrack') for ball in tail))

    def test_static_white_marks_and_slow_boots_do_not_become_motion_ball(self):
        for speed in (0,.002):
            frames=[dict(time=index/30,balls=[dict(frame=index,cx=.3+index*speed,cy=.5)])
                for index in range(14)]
            self.assertEqual(coherent_motion_path(frames),{})

    def test_motion_evidence_cannot_join_a_source_cut(self):
        frames=[dict(time=index/30,cut=index==4,
            balls=[dict(frame=index,cx=.7-index*.02,cy=.4)]) for index in range(8)]
        self.assertEqual(coherent_motion_path(frames),{})

    def test_two_equally_sustained_objects_remain_ambiguous(self):
        frames=[dict(time=index/30,balls=[dict(frame=index,cx=.7-index*.02,cy=y)
            for y in (.4,.7)]) for index in range(12)]
        self.assertEqual(coherent_motion_path(frames),{})


if __name__=='__main__':
    unittest.main()

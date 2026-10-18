import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local-processor'))
from football_ball_static import mark_stationary_ball_runs
from ball_trajectory import choose_trajectory

class StaticBallTests(unittest.TestCase):
    def frames(self,moving=False,nearby=False,cut=False):
        return [dict(frame=i,time=i*.1,cut=cut and i==3,
            people=[dict(cx=.5+i*.004,y2=.4,pitchSupport=.9)] if nearby else [],
            balls=[dict(cx=.5+i*(.004 if not moving else -.014),cy=.4,
                x1=.497+i*.004,x2=.503+i*.004,y1=.396,y2=.404,confidence=.9,pitchSupport=.9)]) for i in range(9)]

    def test_camera_pan_does_not_turn_spare_ball_into_a_moving_match_ball(self):
        frames=self.frames();transforms={i:np.array([[1,0,7.68],[0,1,0]]) for i in range(1,9)}
        mark_stationary_ball_runs(frames,transforms,1920,1080,-.5,2)
        self.assertTrue(all(frame['balls'][0].get('backgroundStatic') for frame in frames))
        self.assertTrue(all(ball is None for ball in choose_trajectory(frames,.3164).values()))

    def test_moving_football_and_possession_are_not_static_distractors(self):
        transforms={i:np.array([[1,0,7.68],[0,1,0]]) for i in range(1,9)}
        for frames in [self.frames(moving=True),self.frames(nearby=True)]:
            mark_stationary_ball_runs(frames,transforms,1920,1080,-.5,2)
            self.assertFalse(any(frame['balls'][0].get('backgroundStatic') for frame in frames))

    def test_no_transform_or_short_run_cannot_prove_stationarity(self):
        frames=self.frames()
        mark_stationary_ball_runs(frames,{},1920,1080,-.5,2)
        self.assertFalse(any(frame['balls'][0].get('backgroundStatic') for frame in frames))

if __name__=='__main__':unittest.main()

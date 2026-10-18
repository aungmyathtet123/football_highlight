import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local-processor'))
from tracking_motion import ball_follow_repair_targets, constrained_camera


class BallFollowRepairTests(unittest.TestCase):
    def test_contact_keeps_the_carrier_and_missing_ball_never_becomes_a_detection(self):
        records=[dict(time=t,direct_ball=direct,ball_x=x,camera_target_x=.5,camera_owner='carrier')
                 for t,direct,x in [(0,True,.4),(1,True,.45),(1.2,True,.55),(1.4,False,.9),(1.6,True,.65)]]
        ball_follow_repair_targets(records,1)
        self.assertEqual(records[1]['camera_owner'],'carrier')
        self.assertEqual(records[2]['camera_target_x'],.55)
        self.assertEqual(records[3]['camera_target_x'],.5)
        self.assertFalse(records[3]['direct_ball'])
        self.assertEqual(records[4]['camera_target_x'],.65)

    def test_follow_repair_keeps_a_smooth_measured_flight_inside_portrait(self):
        records=[dict(time=i/20,scene_cut=i==0,action_phase='flight',direct_ball=True,
                      ball_x=.35+i*.012,ball_y=.5,camera_target_x=.3,
                      player_track_id=None,player_x1=None,player_x2=None)
                 for i in range(31)]
        ball_follow_repair_targets(records,0)
        path=constrained_camera([r['camera_target_x'] for r in records],records,.3164,max_speed=.30)
        for index,(record,camera) in enumerate(zip(records,path)):
            self.assertLessEqual(abs(record['ball_x']-camera),.3164/2-.007)
            if index:self.assertLessEqual(abs(camera-path[index-1])/.05,.352)


if __name__=='__main__':unittest.main()

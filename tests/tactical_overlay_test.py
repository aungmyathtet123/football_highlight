import importlib.util
from pathlib import Path
import unittest
import tempfile
import cv2
import numpy as np

spec = importlib.util.spec_from_file_location("tactical_overlay", Path(__file__).parents[1] / "local-processor/tactical-overlay.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
motion_spec = importlib.util.spec_from_file_location("moving_tactical_overlay", Path(__file__).parents[1] / "local-processor/moving-tactical-overlay.py")
motion_module = importlib.util.module_from_spec(motion_spec)
motion_spec.loader.exec_module(motion_module)


class TacticalOverlayTests(unittest.TestCase):
    def records(self):
        return [{"time":i*.1,"direct_ball":True,"joint_fit":True,"subject_confidence":.95,
                 "ball_x":.4+i*.01,"ball_y":.6,"player_track_id":1,"player_x":.4+i*.01,"player_bottom":.7} for i in range(5)]

    def test_predictions_do_not_become_drawings(self):
        records=self.records()
        records[1]["direct_ball"]=False
        self.assertEqual(module.drawing_points(records,records[0],"ball"),[])

    def test_pass_requires_receiver_in_anchor_frame_and_sustained_possession(self):
        records=self.records()
        records[0].update(possession=True,players=[{"trackId":2,"cx":.65,"y2":.7}])
        for r in records[1:]:
            r.update(player_track_id=2,possession=True)
        points=module.drawing_points(records,records[0],"pass")
        self.assertEqual(len(points),2)
        self.assertEqual(points[1][1],[.65,.7])
        records[0]["players"]=[]
        self.assertEqual(module.drawing_points(records,records[0],"pass"),[])

    def test_pitch_calibration_rejects_missing_and_recovers_known_geometry(self):
        spec=importlib.util.spec_from_file_location("pitch_map",Path(__file__).parents[1]/"local-processor/pitch-map.py")
        pitch=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pitch)
        world=pitch.pitch_template()
        image=world*np.float32([8,6])+np.float32([100,100])
        result=pitch.calibrate(image,np.ones(32),1280,720)
        self.assertIsNotNone(result)
        self.assertIsNone(pitch.calibrate(image,np.zeros(32),1280,720))

    def test_verified_pass_produces_transparent_overlay(self):
        records=self.records()
        players=[
            {"trackId":1,"x1":.25,"y1":.35,"x2":.35,"y2":.75,"cx":.30,"confidence":.96},
            {"trackId":2,"x1":.60,"y1":.34,"x2":.70,"y2":.70,"cx":.65,"confidence":.96},
        ]
        records[0].update(possession=True,players=players,player_track_id=1,ball_x=.32,ball_y=.70)
        for r in records[1:]:
            r.update(player_track_id=2,possession=True)
        with tempfile.TemporaryDirectory() as folder:
            source=str(Path(folder)/"source.avi")
            writer=cv2.VideoWriter(source,cv2.VideoWriter_fourcc(*"MJPG"),10,(320,180))
            self.assertTrue(writer.isOpened())
            frame=np.full((180,320,3),(30,110,30),np.uint8)
            for player in players:
                cv2.rectangle(frame,(int(player["x1"]*320),int(player["y1"]*180)),
                              (int(player["x2"]*320),int(player["y2"]*180)),(20,20,230),-1)
            for _ in range(5): writer.write(frame)
            writer.release()
            output=str(Path(folder)/"overlay.png")
            evidence={"sourceStartTime":0,"sourceRecords":records,"keyframes":[{"time":0,"cropBox":[0,0,1,1]}]}
            result=module.build_overlay(source,evidence,0,"pass",output)
            self.assertTrue(result["approved"])
            image=cv2.imread(output,cv2.IMREAD_UNCHANGED)
            self.assertEqual(image.shape,(1920,1080,4))
            self.assertGreater(np.count_nonzero(image[:,:,3]),100)
            self.assertEqual(image[0,0,3],0)
            self.assertEqual(len(result["stages"]),3)
            self.assertTrue(all(Path(path).exists() for path in result["stages"]))

    def test_pass_overlay_adds_only_kit_matched_support_and_progressive_stages(self):
        players = [
            {"trackId":1,"x1":.15,"y1":.35,"x2":.25,"y2":.72,"cx":.20,"confidence":.96,"pitchSupport":.8,"trackAge":5},
            {"trackId":2,"x1":.66,"y1":.34,"x2":.76,"y2":.71,"cx":.71,"confidence":.96,"pitchSupport":.8,"trackAge":5},
            {"trackId":3,"x1":.40,"y1":.24,"x2":.50,"y2":.61,"cx":.45,"confidence":.93,"pitchSupport":.8,"trackAge":5},
            {"trackId":4,"x1":.44,"y1":.51,"x2":.54,"y2":.88,"cx":.49,"confidence":.95,"pitchSupport":.8,"trackAge":5},
        ]
        records=self.records()
        records[0].update(possession=True,players=players,player_track_id=1,player_x=.20,player_bottom=.72,ball_x=.22,ball_y=.70)
        for record in records[1:]:
            record.update(player_track_id=2,possession=True)
        with tempfile.TemporaryDirectory() as folder:
            source=str(Path(folder)/"source.avi")
            writer=cv2.VideoWriter(source,cv2.VideoWriter_fourcc(*"MJPG"),10,(640,360))
            self.assertTrue(writer.isOpened())
            frame=np.full((360,640,3),(30,110,30),np.uint8)
            for player in players:
                color=(20,20,230) if player["trackId"] in (1,2,3) else (230,30,20)
                cv2.rectangle(frame,(int(player["x1"]*640),int(player["y1"]*360)),
                              (int(player["x2"]*640),int(player["y2"]*360)),color,-1)
            for _ in range(5): writer.write(frame)
            writer.release()
            decoded=cv2.VideoCapture(source)
            ok,image=decoded.read()
            decoded.release()
            self.assertTrue(ok)
            supports=module.same_team_support_players(image,records[0],players[0],players[1])
            self.assertEqual([player["trackId"] for player in supports],[3])
            output=str(Path(folder)/"overlay.png")
            evidence={"sourceStartTime":0,"sourceRecords":records,"keyframes":[{"time":0,"cropBox":[0,0,1,1]}]}
            result=module.build_overlay(source,evidence,0,"pass",output,1920,1080,True)
            self.assertTrue(result["approved"])
            self.assertEqual(result["supportPlayers"],1)
            self.assertEqual(result["connectorCount"],2)
            alpha_counts=[]
            for stage in result["stages"]:
                stage_image=cv2.imread(stage,cv2.IMREAD_UNCHANGED)
                alpha_counts.append(np.count_nonzero(stage_image[:,:,3]))
            self.assertLess(alpha_counts[0],alpha_counts[1])
            self.assertLess(alpha_counts[1],alpha_counts[2])

    def test_pass_overlay_rejects_opponent_as_receiver(self):
        players = [
            {"trackId":1,"x1":.20,"y1":.32,"x2":.31,"y2":.74,"cx":.255,"confidence":.96},
            {"trackId":2,"x1":.62,"y1":.31,"x2":.73,"y2":.73,"cx":.675,"confidence":.96},
        ]
        records=self.records()
        records[0].update(possession=True,players=players,player_track_id=1,player_x=.255,
                          player_bottom=.74,ball_x=.28,ball_y=.71)
        for record in records[1:]:
            record.update(player_track_id=2,possession=True)
        with tempfile.TemporaryDirectory() as folder:
            source=str(Path(folder)/"source.avi")
            writer=cv2.VideoWriter(source,cv2.VideoWriter_fourcc(*"MJPG"),10,(640,360))
            self.assertTrue(writer.isOpened())
            frame=np.full((360,640,3),(30,110,30),np.uint8)
            cv2.rectangle(frame,(128,115),(198,266),(20,20,230),-1)
            cv2.rectangle(frame,(397,112),(467,263),(230,30,20),-1)
            for _ in range(5): writer.write(frame)
            writer.release()
            output=str(Path(folder)/"overlay.png")
            evidence={"sourceStartTime":0,"sourceRecords":records,"keyframes":[{"time":0,"cropBox":[0,0,1,1]}]}
            result=module.build_overlay(source,evidence,0,"pass",output,1920,1080,True)
            self.assertFalse(result["approved"])
            self.assertEqual(result["reason"],"pass_endpoints_not_same_team")

    def test_native_landscape_overlay_uses_full_frame_coordinates(self):
        records=self.records()
        players=[
            {"trackId":1,"x1":.25,"y1":.35,"x2":.35,"y2":.75,"cx":.30,"confidence":.96},
            {"trackId":2,"x1":.60,"y1":.34,"x2":.70,"y2":.70,"cx":.65,"confidence":.96},
        ]
        records[0].update(possession=True,players=players,player_track_id=1,ball_x=.32,ball_y=.70)
        for r in records[1:]:
            r.update(player_track_id=2,possession=True)
        with tempfile.TemporaryDirectory() as folder:
            source=str(Path(folder)/"source.avi")
            writer=cv2.VideoWriter(source,cv2.VideoWriter_fourcc(*"MJPG"),10,(320,180))
            self.assertTrue(writer.isOpened())
            frame=np.full((180,320,3),(30,110,30),np.uint8)
            for player in players:
                cv2.rectangle(frame,(int(player["x1"]*320),int(player["y1"]*180)),
                              (int(player["x2"]*320),int(player["y2"]*180)),(20,20,230),-1)
            for _ in range(5): writer.write(frame)
            writer.release()
            output=str(Path(folder)/"overlay.png")
            evidence={"sourceStartTime":0,"sourceRecords":records,"keyframes":[{"time":0,"cropBox":[.3,0,.7,1]}]}
            result=module.build_overlay(source,evidence,0,"pass",output,1920,1080,True)
            self.assertTrue(result["approved"])
            image=cv2.imread(output,cv2.IMREAD_UNCHANGED)
            self.assertEqual(image.shape,(1080,1920,4))
            self.assertGreater(np.count_nonzero(image[:,:,3]),100)

    def test_verified_pass_generates_a_smoothed_live_network_sequence(self):
        records=[]
        keyframes=[]
        for index in range(10):
            time=index*.1
            receiver_control=index>=6
            records.append({
                "time":time,"direct_ball":True,"joint_fit":True,"subject_confidence":.95,
                "ball_x":.22+index*.006,"ball_y":.62,"possession":True,"scene_cut":False,
                "player_track_id":2 if receiver_control else 1,
                "action_phase":"contact" if index==8 else "setup",
                "players":[
                    {"trackId":1,"cx":.22+index*.006,"y2":.70,"confidence":.96},
                    {"trackId":2,"cx":.68-index*.004,"y2":.68,"confidence":.95},
                ],
            })
            keyframes.append({"time":time,"cropBox":[0,0,1,1]})
        evidence={"sourceStartTime":10,"sourceRecords":records,"keyframes":keyframes}
        with tempfile.TemporaryDirectory() as folder:
            result=motion_module.render_motion(evidence,10,str(Path(folder)/"frames"),640,360,True)
            self.assertTrue(result["approved"])
            self.assertGreaterEqual(result["frameCount"],12)
            first=cv2.imread(str(Path(folder)/"frames"/"00000.png"),cv2.IMREAD_UNCHANGED)
            last=cv2.imread(str(Path(folder)/"frames"/f"{result['frameCount']-1:05d}.png"),cv2.IMREAD_UNCHANGED)
            self.assertGreater(np.count_nonzero(first[:,:,3]),100)
            self.assertGreater(np.count_nonzero(last[:,:,3]),100)
            self.assertNotEqual(np.where(first[:,:,3]>0)[1].mean(),np.where(last[:,:,3]>0)[1].mean())

    def test_run_stops_on_identity_change(self):
        records=self.records()
        records[1]["player_track_id"]=2
        self.assertEqual(module.drawing_points(records,records[0],"run"),[])

    def test_cut_stops_path(self):
        records=self.records()
        records[1]["scene_cut"]=True
        self.assertEqual(module.drawing_points(records,records[0],"ball"),[])

    def test_observed_path_and_untextured_registration(self):
        records=self.records()
        self.assertEqual(len(module.drawing_points(records,records[0],"ball")),5)
        image=np.zeros((200,300,3),np.uint8)
        self.assertIsNone(module.register_frame(image,image))

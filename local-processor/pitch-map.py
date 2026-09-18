"""Calibrated tactical freeze map, never an official offside measurement.

Landmark numbering follows the model author's published figure-keypoints.png:
https://huggingface.co/martinjolif/yolo-football-pitch-detection
The 105x68 template is illustrative; no distances or offside verdicts are output.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np


def pitch_template():
    arc = (9.15**2 - 5.5**2)**.5
    return np.float32([(0,0),(0,13.84),(0,24.84),(0,43.16),(0,54.16),(0,68),
        (5.5,24.84),(5.5,43.16),(11,34),(16.5,13.84),(16.5,34-arc),(16.5,34+arc),(16.5,54.16),
        (52.5-9.15,34),(52.5,0),(52.5,24.85),(52.5,43.15),(52.5,68),(52.5+9.15,34),
        (88.5,13.84),(88.5,34-arc),(88.5,34+arc),(88.5,54.16),(94,34),(99.5,24.84),(99.5,43.16),
        (105,0),(105,13.84),(105,24.84),(105,43.16),(105,54.16),(105,68)])


def calibrate(xy, confidence, width, height):
    if np.asarray(xy).shape != (32,2):
        return None
    valid = (np.asarray(confidence) >= .65) & (xy[:,0] > 0) & (xy[:,0] < width) & (xy[:,1] > 0) & (xy[:,1] < height)
    observed, field = xy[valid], pitch_template()[valid]
    if len(observed) < 6 or cv2.contourArea(cv2.convexHull(observed)) < width*height*.015:
        return None
    matrix, mask = cv2.findHomography(field, observed, cv2.RANSAC, 4)
    if matrix is None or mask.sum() < 6 or mask.mean() < .8 or not np.isfinite(matrix).all():
        return None
    inside=mask.ravel().astype(bool)
    field, observed = field[inside], observed[inside]
    errors=[]
    for i in range(len(field)):
        keep=np.arange(len(field)) != i
        check,_=cv2.findHomography(field[keep],observed[keep],0)
        if check is None:
            return None
        prediction=cv2.perspectiveTransform(field[i:i+1].reshape(-1,1,2),check)[0,0]
        errors.append(float(np.linalg.norm(prediction-observed[i])))
    if max(errors) > 12 or np.median(errors) > 5:
        return None
    return np.linalg.inv(matrix), {"landmarks":len(field),"medianHoldoutErrorPx":float(np.median(errors))}


def render_map(source, evidence, time, model_path, output, output_width=1080, output_height=1920, native_landscape=False):
    from ultralytics import YOLO
    import torch
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mplsoccer import Pitch
    records=evidence.get("sourceRecords",[])
    if not records:
        return {"approved":False,"reason":"missing_tracking"}
    anchor=min(records,key=lambda r:abs(evidence["sourceStartTime"]+r["time"]-time))
    if not anchor.get("players") or abs(evidence["sourceStartTime"]+anchor["time"]-time) > .08:
        return {"approved":False,"reason":"missing_same_frame_players"}
    frames=evidence.get("keyframes",[])
    if not frames:
        return {"approved":False,"reason":"missing_crop"}
    crop=[0,0,1,1] if native_landscape else min(frames,key=lambda k:abs(evidence["sourceStartTime"]+k["time"]-time))["cropBox"]
    # Map occupies the upper inset, including margins. Never obscure action.
    map_width=min(720,output_width*.66)
    map_height=map_width*2/3
    map_x=(output_width-map_width)/2
    map_y=90 if native_landscape else 180
    for x,y in [(anchor.get("ball_x"),anchor.get("ball_y")),(anchor.get("player_x"),anchor.get("player_top")),(anchor.get("player_x"),anchor.get("player_bottom"))]:
        if x is None or y is None:
            return {"approved":False,"reason":"unknown_subject_position"}
        px=(x-crop[0])/(crop[2]-crop[0])*output_width
        py=(y-crop[1])/(crop[3]-crop[1])*output_height
        if map_x-20 < px < map_x+map_width+20 and map_y-20 < py < map_y+map_height+20:
            return {"approved":False,"reason":"map_would_obscure_action"}
    cap=cv2.VideoCapture(source)
    cap.set(cv2.CAP_PROP_POS_MSEC,time*1000)
    ok,image=cap.read();cap.release()
    if not ok:
        return {"approved":False,"reason":"unreadable_frame"}
    torch.set_num_threads(4)
    result=YOLO(model_path).predict(image,imgsz=1280,device="cpu",verbose=False)[0]
    if result.keypoints is None or not len(result.keypoints.xy):
        return {"approved":False,"reason":"pitch_landmarks_not_detected"}
    calibration=calibrate(result.keypoints.xy[0].cpu().numpy(),result.keypoints.conf[0].cpu().numpy(),image.shape[1],image.shape[0])
    if calibration is None:
        return {"approved":False,"reason":"pitch_calibration_uncertain"}
    matrix, quality=calibration
    players=anchor["players"]
    feet=np.float32([[[p["cx"]*image.shape[1],p["y2"]*image.shape[0]]] for p in players])
    positions=cv2.perspectiveTransform(feet,matrix).reshape(-1,2)
    valid=(positions[:,0]>=0)&(positions[:,0]<=105)&(positions[:,1]>=0)&(positions[:,1]<=68)
    if valid.mean()<.8:
        return {"approved":False,"reason":"players_outside_calibrated_pitch"}
    pitch=Pitch(pitch_type="custom",pitch_length=105,pitch_width=68,pitch_color="#15251e",line_color="#aabcb0")
    fig,ax=pitch.draw(figsize=(6,4));fig.patch.set_facecolor("#15251e")
    for p,xy,on_pitch in zip(players,positions,valid):
        if on_pitch:
            active=p.get("trackId")==anchor.get("player_track_id")
            pitch.scatter(xy[0],xy[1],s=85 if active else 30,c="#ffdc50" if active else "#eeeeee",ax=ax)
    ax.set_title("TACTICAL POSITIONS · APPROXIMATE",color="white",fontsize=10)
    Path(output).parent.mkdir(parents=True,exist_ok=True)
    fig.savefig(output,dpi=100,facecolor=fig.get_facecolor(),bbox_inches="tight");plt.close(fig)
    return {"approved":True,"sourceTime":time,"path":str(Path(output).resolve()),**quality}


if __name__ == "__main__":
    p=argparse.ArgumentParser()
    for name in ["source","evidence","model","output"]:
        p.add_argument("--"+name,required=True)
    p.add_argument("--time",required=True,type=float)
    p.add_argument("--width",type=int,default=1080)
    p.add_argument("--height",type=int,default=1920)
    p.add_argument("--native-landscape",action="store_true")
    args=p.parse_args()
    print(json.dumps(render_map(args.source,json.loads(Path(args.evidence).read_text()),args.time,args.model,args.output,
        args.width,args.height,args.native_landscape)))

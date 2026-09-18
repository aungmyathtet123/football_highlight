import argparse
import json
from pathlib import Path
import time
import cv2
import torch
from ultralytics import YOLO

parser=argparse.ArgumentParser()
parser.add_argument("--source",required=True)
parser.add_argument("--model",required=True)
parser.add_argument("--output",required=True)
parser.add_argument("--times",default="42.4,42.8,43.2,43.6")
args=parser.parse_args()
torch.set_num_threads(4)
model=YOLO(args.model)
print(model.names,flush=True)
ball_ids=[k for k,v in model.names.items() if v.lower() in {"ball","sports ball"}]
if not ball_ids:raise RuntimeError("Model has no ball class")
capture=cv2.VideoCapture(args.source)
images=[]
report=[]
for timestamp in map(float,args.times.split(",")):
    capture.set(cv2.CAP_PROP_POS_MSEC,timestamp*1000)
    ok,frame=capture.read()
    if not ok:continue
    start=time.monotonic()
    result=model.predict(frame,imgsz=1280,conf=.03,classes=ball_ids,verbose=False,device="cpu")[0]
    elapsed=time.monotonic()-start
    detections=[]
    for box,score in zip(result.boxes.xyxy.tolist(),result.boxes.conf.tolist()):
        detections.append({"box":box,"confidence":score})
        x1,y1,x2,y2=map(round,box)
        cv2.rectangle(frame,(x1,y1),(x2,y2),(0,255,255),2)
        cv2.putText(frame,f'{score:.2f}',(x2+3,y1),cv2.FONT_HERSHEY_SIMPLEX,.5,(0,255,255),1)
    cv2.putText(frame,f'{timestamp:.2f}s',(10,35),cv2.FONT_HERSHEY_SIMPLEX,1,(255,255,255),2)
    images.append(cv2.resize(frame,(640,360)))
    report.append({"time":timestamp,"seconds":elapsed,"detections":detections})
    print(json.dumps(report[-1]),flush=True)
capture.release()
output=Path(args.output)
output.parent.mkdir(parents=True,exist_ok=True)
cv2.imwrite(str(output),cv2.vconcat([cv2.hconcat(images[i:i+2]) for i in range(0,len(images),2)]),[cv2.IMWRITE_JPEG_QUALITY,45])
output.with_suffix(".json").write_text(json.dumps(report,indent=2))

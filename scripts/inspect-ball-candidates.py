import argparse
import json
import sqlite3
from pathlib import Path
import cv2

parser=argparse.ArgumentParser()
parser.add_argument("--source",required=True)
parser.add_argument("--cache",required=True)
parser.add_argument("--output",required=True)
parser.add_argument("--times",required=True)
args=parser.parse_args()
db=sqlite3.connect(args.cache)
capture=cv2.VideoCapture(args.source)
fps=capture.get(cv2.CAP_PROP_FPS)
images=[]
for timestamp in map(float,args.times.split(",")):
    number=round(timestamp*fps)
    row=db.execute("SELECT frame,payload FROM observations WHERE abs(frame-?)<=2 ORDER BY abs(frame-?),length(payload) DESC LIMIT 1",(number,number)).fetchone()
    if not row: continue
    capture.set(cv2.CAP_PROP_POS_FRAMES,row[0])
    ok,image=capture.read()
    if not ok:continue
    people,balls=json.loads(row[1])
    h,w=image.shape[:2]
    for ball in balls:
        if ball["confidence"]<.04:continue
        x,y=round(ball["cx"]*w),round(ball["cy"]*h)
        color=(0,255,0) if ball["confidence"]>=.12 else (0,180,255)
        cv2.circle(image,(x,y),8,color,1)
        cv2.putText(image,f'{ball["confidence"]:.2f}',(x+8,y),cv2.FONT_HERSHEY_SIMPLEX,.35,color,1)
    cv2.putText(image,f'{row[0]/fps:.2f}s',(10,35),cv2.FONT_HERSHEY_SIMPLEX,1,(255,255,255),2)
    images.append(cv2.resize(image,(640,360)))
capture.release()
db.close()
output=Path(args.output)
output.parent.mkdir(parents=True,exist_ok=True)
cv2.imwrite(str(output),cv2.vconcat([cv2.hconcat(images[i:i+2]) for i in range(0,len(images),2)]),[cv2.IMWRITE_JPEG_QUALITY,45])

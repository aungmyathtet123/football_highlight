"""Local diagnostic: compare sampled source frames with the actual crop bounds."""
import argparse
import json
from pathlib import Path
import cv2

parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--tracking", required=True)
parser.add_argument("--scene", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
evidence = json.loads(Path(args.tracking).read_text())["moments"][args.scene]
capture = cv2.VideoCapture(args.source)
images = []
frames = evidence["keyframes"]
records = evidence["sourceRecords"]
for index in [round(i * (len(frames) - 1) / 11) for i in range(12)]:
    k, r = frames[index], records[index]
    capture.set(cv2.CAP_PROP_POS_MSEC, (evidence["sourceStartTime"] + k["time"]) * 1000)
    ok, image = capture.read()
    if not ok:
        continue
    h, w = image.shape[:2]
    x1, y1, x2, y2 = k["cropBox"]
    cv2.rectangle(image, (round(x1*w), round(y1*h)), (round(x2*w), round(y2*h)), (0,255,255), 2)
    if r["ball_x"] is not None:
        cv2.circle(image, (round(r["ball_x"]*w), round(r["ball_y"]*h)), 12,
                   (0,255,0) if k["directBall"] else (0,0,255), 2)
    label = f'{evidence["sourceStartTime"] + k["time"]:.2f}s {k["actionPhase"]}'
    cv2.putText(image,label,(10,30),cv2.FONT_HERSHEY_SIMPLEX,.8,(255,255,255),2)
    images.append(cv2.resize(image,(320,180)))
capture.release()
if len(images) != 12:
    raise RuntimeError("Could not inspect all requested source frames")
sheet = cv2.vconcat([cv2.hconcat(images[i:i+3]) for i in range(0,12,3)])
output = Path(args.output)
output.parent.mkdir(parents=True,exist_ok=True)
cv2.imwrite(str(output),sheet,[cv2.IMWRITE_JPEG_QUALITY,45])
print(output.resolve())

"""Measure an isolated detector against visible-ball reference boxes.

Does not measure tracking, camera or narration quality. Frames without a ball
reference are excluded; absence of an annotation is not a negative label.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import time


def iou(a, b):
    intersection = max(0, min(a[2], b[2])-max(a[0], b[0]))*max(0, min(a[3], b[3])-max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection
    return intersection/union if union > 0 else 0


def center_error(a, b):
    distance=math.hypot((a[0]+a[2]-b[0]-b[2])/2,(a[1]+a[3]-b[1]-b[3])/2)
    radius=max(4,math.hypot(b[2]-b[0],b[3]-b[1])/2)
    return distance/radius


def benchmark(manifest_path, model_path, output, confidence=.03, image_size=1280):
    import torch
    from ultralytics import YOLO
    torch.set_num_threads(4)
    manifest = json.loads(manifest_path.read_text())
    model = YOLO(str(model_path))
    ball_classes = {int(key) for key, value in model.names.items() if str(value).lower() in {'ball', 'sports ball', 'football'}}
    if not ball_classes: raise RuntimeError('Model has no football/sports ball class')
    rows = []
    started = time.time()
    for frame in manifest['frames']:
        if not frame['ballReferenceAvailable']: continue
        path = manifest_path.parent/frame['image']
        if hashlib.sha256(path.read_bytes()).hexdigest() != frame['sha256']: raise RuntimeError('Benchmark image changed')
        result = model.predict(str(path), imgsz=image_size, conf=confidence, device='cpu', verbose=False)[0]
        predictions = [box.xyxy[0].tolist() for box in result.boxes if int(box.cls[0]) in ball_classes]
        targets = [[x, y, x+w, y+h] for x, y, w, h in frame['ballBoxesXYWH']]
        matches = sorted([(iou(prediction,target),p,t) for p,prediction in enumerate(predictions)
                          for t,target in enumerate(targets)], reverse=True)
        used_p, used_t = set(), set()
        for overlap,p,t in matches:
            if overlap >= .5 and p not in used_p and t not in used_t: used_p.add(p);used_t.add(t)
        center_p,center_t=set(),set()
        for error,p,t in sorted((center_error(prediction,target),p,t) for p,prediction in enumerate(predictions) for t,target in enumerate(targets)):
            if error<=1 and p not in center_p and t not in center_t:center_p.add(p);center_t.add(t)
        rows.append({'sequence': frame['sequence'], 'frame': frame['frame'], 'truePositives': len(used_t),
            'falsePositives': len(predictions)-len(used_p), 'falseNegatives': len(targets)-len(used_t),
            'centerMatches':len(center_t),'predictions':len(predictions),'referenceBalls':len(targets)})
    tp,fp,fn = (sum(row[key] for row in rows) for key in ['truePositives','falsePositives','falseNegatives'])
    report = {'version':1,'scope':'isolated_visible_ball_detector','dataset':manifest['dataset'],
        'revision':manifest['revision'],'officialPartition':manifest['officialPartition'],
        'pretrainingOverlap':manifest['pretrainingOverlap'],'model':model_path.name,
        'modelSha256':hashlib.sha256(model_path.read_bytes()).hexdigest(),'confidence':confidence,
        'imageSize':image_size,'iouThreshold':.5,'evaluatedFrames':len(rows),
        'unlabelledBallFramesSkipped':len(manifest['frames'])-len(rows),
        'precision':tp/(tp+fp) if tp+fp else None,'recall':tp/(tp+fn) if tp+fn else None,
        'centerPrecision':sum(row['centerMatches'] for row in rows)/max(1,sum(row['predictions'] for row in rows)),
        'centerRecall':sum(row['centerMatches'] for row in rows)/max(1,sum(row['referenceBalls'] for row in rows)),
        'centerThreshold':'max(4 pixels, half reference-ball diagonal)',
        'truePositives':tp,'falsePositives':fp,'falseNegatives':fn,'elapsedSeconds':round(time.time()-started,2),
        'frames':rows,'supportsFullPipelineReliabilityClaim':False}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='frames'},indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',type=Path,required=True);parser.add_argument('--model',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True);parser.add_argument('--confidence',type=float,default=.03)
    parser.add_argument('--image-size',type=int,default=1280)
    args=parser.parse_args();benchmark(args.manifest,args.model,args.output,args.confidence,args.image_size)

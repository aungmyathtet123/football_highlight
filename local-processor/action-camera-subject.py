"""Recompose a camera from saved native observations, without rerunning YOLO."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
from statistics import median
import numpy as np


def actor_targets(records, strategy, contact, decision_time=None):
    referees={}
    if strategy=='referee':
        for record in records:
            if record['time']<=contact+.25:continue
            for person in record.get('players',[]):
                if person.get('role')=='referee' and person.get('confidence',0)>=.45 and person.get('trackId') is not None:
                    referees[person['trackId']]=referees.get(person['trackId'],0)+person['confidence']
    referee=max(referees,key=referees.get) if referees else None
    previous=None
    for record in records:
        if strategy=='referee' and record['time']<=contact+.25:continue
        box=None
        if strategy=='reaction':
            box=record.get('observed_closeup_box')
            if box is None and record.get('player_track_id') is not None and record.get('subject_confidence',0)>=.45:
                box=[record.get(key) for key in ('player_x1','player_top','player_x2','player_bottom')]
        else:
            person=next((p for p in record.get('players',[]) if p.get('role')=='referee'
                and p.get('trackId')==referee and p.get('confidence',0)>=.45),None)
            if person:box=[person[key] for key in ('x1','y1','x2','y2')]
        if box is not None and not (len(box)==4 and all(isinstance(v,(int,float)) for v in box)
                and 0<=box[0]<box[2]<=1 and 0<=box[1]<box[3]<=1):box=None
        record['camera_owner']='decision_handoff' if strategy=='referee' and decision_time is not None \
            and record['time']<decision_time-.15 else strategy
        record['framing_subject_box']=box
        if box is not None:
            previous=(box[0]+box[2])/2
            record['camera_target_x']=previous
        elif previous is not None:record['camera_target_x']=previous
    return records


def recompose(payload):
    scene=payload['scene'];evidence=copy.deepcopy(payload['evidence']);media=payload['media']
    records=evidence['sourceRecords'];brief=scene.get('trackingBrief') or {}
    contact=brief.get('contactTime',scene['startTime'])-scene['startTime']
    decision=brief.get('payoffStartTime',scene['endTime'])-scene['startTime']
    actor_targets(records,payload['strategy'],contact,decision)
    path=Path(__file__).with_name('track-football-v2.py')
    spec=importlib.util.spec_from_file_location('native_tracker',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    frames,_=module.build_keyframes(records,media['width'],media['height'],
        median(frame['cameraX'] for frame in evidence['keyframes']),payload['width'],payload['height'],0,1,
        len(records)/max(.01,scene['endTime']-scene['startTime']),contact,0,0,False,scene['eventType'])
    for record,frame in zip(records,frames):
        if record.get('camera_owner') in {'reaction','referee','decision_handoff'}:
            frame.update(markerVisible=0,ballMarkerVisible=0,highlightMode='none')
    velocities=[(i,frames[i]['cameraX']-frames[i-1]['cameraX']) for i in range(1,len(frames))
        if not frames[i].get('sceneCut') and not frames[i].get('cameraCut')]
    steps=[abs(value) for _,value in velocities]
    jerks=[abs(b[1]-a[1]) for a,b in zip(velocities,velocities[1:]) if b[0]==a[0]+1]
    evidence.update(keyframes=frames,sourceRecords=records,finalCropVerified=False,
        renderReview=None,initialRenderReview=None,reviewRepairError=None,
        trackingBrief=brief,zoom=1,annotation={'style':'none','confidence':0,'duration':0},highlightCoverage=0,
        cameraMaxStep=max(steps,default=0),cameraStepP95=float(np.percentile(steps,95)) if steps else 0,
        cameraJerkP95=float(np.percentile(jerks,95)) if jerks else 0,
        directBallInFrameCoverage=sum(f.get('directBall') and f.get('ballInFrame') for f in frames)/max(1,len(frames)),
        cameraRecomposition={'version':1,'strategy':payload['strategy'],'nativeObservationsReused':True})
    return evidence


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();payload=json.loads(args.input.read_text(encoding='utf-8-sig'))
    args.output.write_text(json.dumps(recompose(payload)),encoding='utf-8')

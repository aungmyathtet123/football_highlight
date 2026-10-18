"""Identify persistent background distractors without deleting detections.

White adverts and spare balls may follow a broadcast pan as smoothly as a real
football. Camera-compensated stationarity is evidence against those candidates
during flight, never a coordinate for the actual moving match ball.
"""
import math
import cv2
import numpy as np


def mark_stationary_ball_runs(observations, transforms, width, height, contact, payoff):
    tracks = []
    tolerance = max(2.5, width*.0016)
    for index, observation in enumerate(observations):
        time = observation['time']
        transform = transforms.get(index)
        if (index == 0 or observation.get('cut') or transform is None
                or time <= contact+.12 or time >= payoff):
            tracks = []
        current = []
        for ball in observation['balls']:
            # A stopped ball at the carrier/keeper is legitimate possession.
            nearby = any(math.hypot(ball['cx']-p['cx'],(ball['cy']-p['y2'])*height/width)<.055
                for p in observation['people'] if p.get('pitchSupport',0)>=.08)
            if nearby or ball.get('motionTrack'):
                continue
            matches=[]
            if transform is not None:
                for track in tracks:
                    old=track[-1][1]
                    predicted=transform @ np.array([old['cx']*width,old['cy']*height,1.])
                    error=math.hypot(ball['cx']*width-predicted[0],ball['cy']*height-predicted[1])
                    if error<=tolerance:matches.append((error,track))
            track=[*(min(matches,key=lambda item:item[0])[1] if matches else []),(time,ball)]
            current.append(track)
            if len(track)>=5 and time-track[0][0]>=.30:
                for _,candidate in track:
                    candidate['backgroundStatic']=True
        tracks=current
    return observations


def observe_static_ball_distractors(capture, observations, source_fps, contact, payoff):
    if len(observations)<5:return
    transforms={};previous=None
    wanted={int(item['frame']):index for index,item in enumerate(observations)}
    capture.set(cv2.CAP_PROP_POS_FRAMES,min(wanted))
    while True:
        ok,frame=capture.read()
        if not ok:break
        number=int(capture.get(cv2.CAP_PROP_POS_FRAMES))-1
        if number>max(wanted):break
        if number not in wanted:continue
        index=wanted[number];height,width=frame.shape[:2]
        small_width=min(960,width);small_height=round(height*small_width/width)
        gray=cv2.cvtColor(cv2.resize(frame,(small_width,small_height)),cv2.COLOR_BGR2GRAY)
        if previous is not None and not observations[index].get('cut'):
            features=cv2.goodFeaturesToTrack(previous,maxCorners=400,qualityLevel=.015,minDistance=10)
            if features is not None and len(features)>=12:
                moved,status,_=cv2.calcOpticalFlowPyrLK(previous,gray,features,None)
                if moved is not None and int(status.sum())>=12:
                    valid=status.ravel()==1
                    transform,inliers=cv2.estimateAffinePartial2D(features[valid],moved[valid],
                        method=cv2.RANSAC,ransacReprojThreshold=1.5)
                    if transform is not None and inliers.mean()>=.60:
                        transform[:,2]*=width/small_width
                        transforms[index]=transform
        previous=gray
    mark_stationary_ball_runs(observations,transforms,width,height,contact,payoff)

"""Tiny moving-ball proposals from native frames, with camera motion removed.

These observations complement the learned detector during a fast finish. They
never manufacture a ball in an occlusion or prove the sporting outcome.
"""
import math
import cv2
import numpy as np


def coherent_motion_path(frames, minimum_hits=5):
    """Keep a sustained fast trajectory, rather than isolated white pixels."""
    tracks = []
    for frame in frames:
        if frame.get('cut'):
            for track in tracks:
                track['closed'] = True
        current = []
        for candidate in frame['balls']:
            point = (frame['time'], candidate)
            best = None
            for track in tracks:
                if track.get('closed'):
                    continue
                time, old = track['points'][-1]
                dt = frame['time']-time
                if not .015 <= dt <= .16:
                    continue
                vx = (candidate['cx']-old['cx'])/dt
                vy = (candidate['cy']-old['cy'])/dt
                speed = math.hypot(vx, vy*.6)
                if not .22 <= speed <= 2.5:
                    continue
                if len(track['points']) >= 2:
                    earlier, before = track['points'][-2]
                    delta = time-earlier
                    px = old['cx']+(old['cx']-before['cx'])/delta*dt
                    py = old['cy']+(old['cy']-before['cy'])/delta*dt
                    error = math.hypot(candidate['cx']-px, (candidate['cy']-py)*.6)
                    if error > .012 + dt*.08:
                        continue
                else:
                    error = 0
                rank = (len(track['points']), -error)
                if best is None or rank > best[0]:
                    best = (rank, track)
            points = [*best[1]['points'], point] if best else [point]
            current.append({'points': points})
        tracks.extend(current)
        # Bound the native search while retaining independent starting points.
        active = sorted((track for track in tracks if not track.get('closed')
            and frame['time']-track['points'][-1][0] <= .16),
            key=lambda track: len(track['points']), reverse=True)[:100]
        completed = [track for track in tracks if len(track['points']) >= minimum_hits
            and (track.get('closed') or frame['time']-track['points'][-1][0] > .16)]
        tracks = [*sorted(completed,key=lambda track:len(track['points']),reverse=True)[:8], *active]
    valid = [track for track in tracks if len(track['points']) >= minimum_hits
        and track['points'][-1][0]-track['points'][0][0] >= .18
        and math.hypot(track['points'][-1][1]['cx']-track['points'][0][1]['cx'],
            (track['points'][-1][1]['cy']-track['points'][0][1]['cy'])*.6) >= .08]
    if not valid:
        return {}
    best = max(valid, key=lambda track: len(track['points']))
    best_by_frame = {candidate['frame']:candidate for _,candidate in best['points']}
    for alternative in valid:
        if alternative is best or len(alternative['points']) < len(best['points'])*.85:
            continue
        paired = [(candidate,best_by_frame[candidate['frame']]) for _,candidate in alternative['points']
            if candidate['frame'] in best_by_frame]
        if len(paired)>=minimum_hits and sum(math.hypot(a['cx']-b['cx'],(a['cy']-b['cy'])*.6)>.05
            for a,b in paired)>len(paired)/2:
            return {}  # Two equally sustained objects remain ambiguous.
    return {candidate['frame']: {**candidate, 'motionTrack': True,
        'observationMethod': 'camera_compensated_motion',
        'motionTrackSamples': len(best['points'])} for _, candidate in best['points']}


def observe_ball_motion(capture, observations, source_fps, start, end):
    """Observe a bounded finish at source cadence; return only measured boxes."""
    if not observations or not source_fps>0:
        return {}
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(start*source_fps)))
    ok, previous = capture.read()
    if not ok:
        return {}
    samples = []
    last_time = (capture.get(cv2.CAP_PROP_POS_FRAMES)-1)/source_fps
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        number = int(capture.get(cv2.CAP_PROP_POS_FRAMES))-1
        time = number/source_fps
        if time > end:
            break
        cut = any(value.get('cut') and last_time < value['time'] <= time for value in observations)
        last_time = time
        height, width = frame.shape[:2]
        people = min(observations,key=lambda value:abs(value['time']-time))['people']
        # This pitch-background method is deliberately limited to wide views.
        if cut or len(people)<4:
            samples.append({'time':time,'balls':[],'cut':cut})
            previous = frame
            continue
        small_width = min(960,width)
        small_height = round(height*small_width/width)
        gray = lambda value: cv2.cvtColor(cv2.resize(value,(small_width,small_height)),cv2.COLOR_BGR2GRAY)
        before, current = gray(previous), gray(frame)
        features = cv2.goodFeaturesToTrack(before, maxCorners=350, qualityLevel=.015, minDistance=12)
        if features is None or len(features)<12:
            previous = frame
            continue
        moved, status, _ = cv2.calcOpticalFlowPyrLK(before,current,features,None)
        if moved is None or status.sum()<12:
            previous = frame
            continue
        valid = status.ravel()==1
        transform, inliers = cv2.estimateAffinePartial2D(features[valid],moved[valid],
            method=cv2.RANSAC,ransacReprojThreshold=1.5)
        if transform is None or inliers.mean()<.6:
            previous = frame
            continue
        transform[:,2] *= width/small_width
        warped = cv2.warpAffine(previous,transform,(width,height))
        difference = cv2.absdiff(frame,warped).max(axis=2)
        hsv = cv2.cvtColor(frame,cv2.COLOR_BGR2HSV)
        mask = ((difference>40)&(hsv[:,:,1]<95)&(hsv[:,:,2]>165)).astype('uint8')*255
        for person in people:
            x1,y1,x2,y2 = [int(value*size) for value,size in zip(
                [person['x1'],person['y1'],person['x2'],person['y2']],[width,height,width,height])]
            cv2.rectangle(mask,(max(0,x1-4),max(0,y1-4)),(min(width,x2+4),min(height,y2+4)),0,-1)
        mask[:int(height*.3)] = 0
        mask[int(height*.85):] = 0
        _, _, stats, centres = cv2.connectedComponentsWithStats(mask)
        balls = []
        scale = width/1920
        for (x,y,w,h,area), (cx,cy) in zip(stats[1:],centres[1:]):
            if not (5*scale**2 <= area <= 450*scale**2
                and 2*scale <= w <= 36*scale and 2*scale <= h <= 36*scale
                and max(w,h)/max(1,min(w,h)) <= 3 and .02<cx/width<.98):
                continue
            radius = max(7,round(14*scale))
            patch = hsv[max(0,int(cy)-radius):int(cy)+radius+1,max(0,int(cx)-radius):int(cx)+radius+1]
            grass = ((patch[:,:,0]>30)&(patch[:,:,0]<90)&(patch[:,:,1]>65)).mean()
            if grass >= .45:
                balls.append(dict(frame=number,cx=float(cx/width),cy=float(cy/height),
                    x1=float(x/width),y1=float(y/height),x2=float((x+w)/width),y2=float((y+h)/height),
                    confidence=.55,pitchSupport=float(grass)))
        samples.append({'time':time,'balls':balls})
        previous = frame
    return coherent_motion_path(samples)

"""Local detector adapters; no hosted detector or additional API key."""
from types import SimpleNamespace
import numpy as np
import supervision as sv
from ultralytics.engine.results import Boxes
from ultralytics.trackers.bot_sort import BOTSORT
from ultralytics.trackers.byte_tracker import BYTETracker
from detector_roles import football_classes

try:
    # TrackTrack was added after Ultralytics 8.4.52. Keep the worker usable if
    # an older compatible image is ever rolled back instead of failing at
    # module import before any scene can be tracked.
    from ultralytics.trackers.track_tracker import TRACKTRACK
except ImportError:
    TRACKTRACK = None


def closeup_people(model, frame, device='cpu'):
    """Measured foreground bodies when a wide-shot role model misses a close-up."""
    _, classes, _ = football_classes(model.names)
    if not classes:
        return []
    result=model.predict(frame,classes=classes,conf=.6,imgsz=960,max_det=10,
        device=device,verbose=False)[0]
    if result.boxes is None:
        return []
    height,width=frame.shape[:2]
    people=[]
    for box,score in zip(result.boxes.xyxy.cpu().numpy(),result.boxes.conf.cpu().numpy()):
        x1,y1,x2,y2=box/np.array([width,height,width,height])
        if y2-y1<.35:
            continue
        people.append(dict(x1=float(x1),y1=float(y1),x2=float(x2),y2=float(y2),
            cx=float((x1+x2)/2),cy=float((y1+y2)/2),confidence=float(score),role='player'))
    return people


def closeup_balls(model, frame, device='cpu'):
    """Use the general sports-ball model at foreground replay scale."""
    _, _, classes = football_classes(model.names)
    if not classes:
        return []
    result = model.predict(frame, classes=classes, conf=.12, imgsz=1280,
        max_det=24, device=device, verbose=False)[0]
    if result.boxes is None:
        return []
    height,width = frame.shape[:2]
    output=[]
    for box,score in zip(result.boxes.xyxy.cpu().numpy(),result.boxes.conf.cpu().numpy()):
        x1,y1,x2,y2=box/np.array([width,height,width,height])
        if not (0<x2-x1<=.13 and 0<y2-y1<=.16):
            continue
        output.append(dict(x1=float(x1),y1=float(y1),x2=float(x2),y2=float(y2),
            cx=float((x1+x2)/2),cy=float((y1+y2)/2),confidence=float(score),
            roleDetector=True,closeupBall=True,observationMethod='general_closeup_ball_detector'))
    return output


class PersonTracker:
    """Associate players after compensating for broadcast camera motion."""
    def __init__(self, sample_fps=10, method="tracktrack", camera_motion="sparseOptFlow"):
        self.sample_fps = sample_fps
        self.method, self.camera_motion = method, camera_motion
        self.reset()

    def reset(self):
        self.hits = {}
        selected_method = self.method
        if selected_method == "tracktrack" and TRACKTRACK is None:
            selected_method = "botsort"
        config = SimpleNamespace(
            track_high_thresh=0.25, track_low_thresh=0.08,
            new_track_thresh=0.25, track_buffer=max(1, round(self.sample_fps * 0.8)), match_thresh=0.8,
            fuse_score=True, gmc_method=self.camera_motion, with_reid=False,
            proximity_thresh=0.5, appearance_thresh=0.8, model="auto",
            tracker_type=selected_method, lost_match_thr=0.86,
            iou_weight=0.58, reid_weight=0.32, conf_weight=0.07, angle_weight=0.03,
            penalty_p=0.2, penalty_q=0.4, reduce_step=0.05,
            tai_thr=0.55, min_track_len=2, device="cpu",
        )
        trackers = {"botsort": BOTSORT, "bytetrack": BYTETracker}
        if TRACKTRACK is not None:
            trackers["tracktrack"] = TRACKTRACK
        if selected_method not in trackers:
            raise ValueError(f"Unsupported player tracker: {selected_method}")
        self.active_method = selected_method
        self.tracker = trackers[selected_method](config)

    def update(self, detections, frame, timestamp):
        height, width = frame.shape[:2]
        boxes = np.array([
            [p["x1"] * width, p["y1"] * height, p["x2"] * width, p["y2"] * height,
             p["confidence"], 0] for p in detections
        ], dtype=np.float32).reshape(-1, 6)
        tracks = self.tracker.update(Boxes(boxes, (height, width)), frame)
        people = []
        for row in tracks:
            # xyxy, track_id, score, class, detection_index (Ultralytics 8.4.52).
            index, identity = int(row[-1]), int(row[4])
            if not 0 <= index < len(detections):
                continue
            person = detections[index]
            self.hits[identity] = self.hits.get(identity, 0) + 1
            person.update(trackId=identity, trackAge=self.hits[identity])
            people.append(person)
        return people


class SlicedBallDetector:
    """Bounded detail searches help reacquire small balls after fast passes."""
    def __init__(self, model, image_size, confidence, device="cpu"):
        self.model, self.image_size = model, image_size
        self.confidence, self.device = confidence, device
        self.ball_classes = football_classes(model.names)[2]
        if not self.ball_classes:
            raise ValueError('The configured ball model has no football/ball class')
        self.frames = self.sliced_frames = 0
        self.slicer = sv.InferenceSlicer(
            callback=self._infer, slice_wh=(640, 640), overlap_wh=(128, 128),
            thread_workers=1,
        )

    def _infer(self, frame):
        result = self.model.predict(
            frame, classes=self.ball_classes, conf=self.confidence, iou=0.5,
            imgsz=min(self.image_size, 960), max_det=24,
            device=self.device, verbose=False,
        )[0]
        return sv.Detections.from_ultralytics(result)

    def search_region(self, frame, region):
        """Magnify a semantic search neighbourhood, not a semantic detection.

        Return only measured native boxes with their original detector scores.
        No model response means no candidate, regardless of the guide.
        """
        height, width = frame.shape[:2]
        size = min(384, width, height)
        cx, cy = (region[0]+region[2])/2, (region[1]+region[3])/2
        left = max(0, min(width-size, int(cx*width-size/2)))
        top = max(0, min(height-size, int(cy*height-size/2)))
        result = self._infer(frame[top:top+size, left:left+size])
        if len(result):
            result.xyxy += np.array([left, top, left, top])
        return list(zip(result.xyxy, result.confidence if result.confidence is not None else []))

    def _refine_weak(self, frame, detections):
        """Magnify at most two native proposals; never inflate their scores."""
        scores = detections.confidence
        if scores is None or not len(scores) or np.any(scores >= .35):
            return detections
        height, width = frame.shape[:2]
        details = []
        for index in np.argsort(-scores)[:2]:
            box = detections.xyxy[index]
            if scores[index] < .04 or max(box[2]-box[0], box[3]-box[1]) > 70:
                continue
            size = min(384, width, height)
            cx, cy = (box[0]+box[2])/2, (box[1]+box[3])/2
            left = max(0, min(width-size, int(cx-size/2)))
            top = max(0, min(height-size, int(cy-size/2)))
            detail = self._infer(frame[top:top+size, left:left+size])
            if len(detail):
                detail.xyxy += np.array([left, top, left, top])
                details.append(detail)
        if details:
            return sv.Detections.merge([detections, *details]).with_nms(threshold=.4)
        return detections

    def detect(self, frame, predicted=None, whole_result=None):
        self.frames += 1
        height, width = frame.shape[:2]
        # Once a trajectory exists, inspect its local neighbourhood first. A
        # successful 640px ROI has more pixels on the football than an expensive
        # 1920px full-frame pass and is substantially faster on CPU. Periodic
        # global searches prevent drift and reacquire the ball after a cut or a
        # long occlusion. This follows the temporal ROI + trajectory-rectification
        # pattern used by dedicated tiny sports-object trackers.
        roi = None
        roi_reliable = False
        if predicted is not None:
            roi_size = min(720, width, height)
            half = roi_size // 2
            left = max(0, min(max(0, width - roi_size), int(predicted[0] * width - half)))
            top = max(0, min(max(0, height - roi_size), int(predicted[1] * height - half)))
            roi = self._infer(frame[top:top+roi_size, left:left+roi_size])
            if len(roi):
                roi.xyxy += np.array([left, top, left, top])
                roi_reliable = roi.confidence is not None and np.any(roi.confidence >= 0.20)

        periodic_global = predicted is None or self.frames % 10 == 1
        # Joint role inference already searched this full source frame. Reuse
        # that result instead of paying for an identical second forward pass.
        observed_whole = (sv.Detections.from_ultralytics(whole_result)
                          if whole_result is not None else None)
        if observed_whole is not None:
            observed_whole = observed_whole[np.isin(observed_whole.class_id, self.ball_classes)]
            # A weak four-pixel ball response is a SEARCH location, not proof.
            # Magnify the current native proposal instead of searching only at
            # the previous position after a fast cross. Limit work to two ROIs.
            observed_whole = self._refine_weak(frame, observed_whole)
        if roi_reliable and not periodic_global:
            whole = roi
        else:
            if observed_whole is not None:
                whole = observed_whole
            else:
                result = self.model.predict(
                    frame, classes=self.ball_classes, conf=self.confidence, iou=0.5,
                    imgsz=self.image_size, max_det=24, device=self.device, verbose=False,
                )[0]
                whole = sv.Detections.from_ultralytics(result)
            if roi is not None and len(roi):
                whole = sv.Detections.merge([whole, roi]).with_nms(threshold=0.4)

        reliable = whole.confidence is not None and np.any(whole.confidence >= 0.35)
        # Tiling is a bounded last-resort reacquisition, not a routine pass.
        full_search = not reliable and self.frames % (8 if predicted is None else 14) == 1
        if full_search:
            detailed = self.slicer(frame)
            self.sliced_frames += 1
            if len(detailed):
                whole = sv.Detections.merge([whole, detailed]).with_nms(threshold=0.4)
                # A tiled proposal can still be too weak for association. The
                # native candidate at its new location gets one bounded detail
                # pass, rather than being discarded until the next global scan.
                whole = self._refine_weak(frame, whole)
        scores = whole.confidence if whole.confidence is not None else np.zeros(len(whole))
        return zip(whole.xyxy, scores)

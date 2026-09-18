"""Local detector adapters; no hosted detector or additional API key."""
from types import SimpleNamespace
import numpy as np
import supervision as sv
from ultralytics.engine.results import Boxes
from ultralytics.trackers.bot_sort import BOTSORT
from ultralytics.trackers.track_tracker import TRACKTRACK


class PersonTracker:
    """Associate players after compensating for broadcast camera motion."""
    def __init__(self, sample_fps=10, method="tracktrack", camera_motion="sparseOptFlow"):
        self.sample_fps = sample_fps
        self.method, self.camera_motion = method, camera_motion
        self.reset()

    def reset(self):
        self.hits = {}
        config = SimpleNamespace(
            track_high_thresh=0.25, track_low_thresh=0.08,
            new_track_thresh=0.25, track_buffer=max(1, round(self.sample_fps * 0.8)), match_thresh=0.8,
            fuse_score=True, gmc_method=self.camera_motion, with_reid=False,
            proximity_thresh=0.5, appearance_thresh=0.8, model="auto",
            tracker_type=self.method, lost_match_thr=0.86,
            iou_weight=0.58, reid_weight=0.32, conf_weight=0.07, angle_weight=0.03,
            penalty_p=0.2, penalty_q=0.4, reduce_step=0.05,
            tai_thr=0.55, min_track_len=2, device="cpu",
        )
        from ultralytics.trackers.byte_tracker import BYTETracker
        trackers = {"tracktrack": TRACKTRACK, "botsort": BOTSORT, "bytetrack": BYTETracker}
        self.tracker = trackers[self.method](config)

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
        self.frames = self.sliced_frames = 0
        self.slicer = sv.InferenceSlicer(
            callback=self._infer, slice_wh=(640, 640), overlap_wh=(128, 128),
            thread_workers=1,
        )

    def _infer(self, frame):
        result = self.model.predict(
            frame, classes=[0], conf=self.confidence, iou=0.5,
            imgsz=min(self.image_size, 960), max_det=24,
            device=self.device, verbose=False,
        )[0]
        return sv.Detections.from_ultralytics(result)

    def detect(self, frame, predicted=None):
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
        if roi_reliable and not periodic_global:
            whole = roi
        else:
            result = self.model.predict(
                frame, classes=[0], conf=self.confidence, iou=0.5,
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
        scores = whole.confidence if whole.confidence is not None else np.zeros(len(whole))
        return zip(whole.xyxy, scores)

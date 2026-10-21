"""Read-only detector timing canary; never starts or changes a video job."""
import argparse
import json
import statistics
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from ultralytics import YOLO
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local-processor'))
from tracking_cpu import bind_detector_cpu_threads


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--threads', default='1,2,3,4,6')
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--bind-callback', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    capture = cv2.VideoCapture(args.source)
    frames = []
    for seconds in [96, 168, 269]:
        capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
        ok, frame = capture.read()
        if not ok:
            raise RuntimeError('Cannot decode benchmark source frame')
        frames.append(frame)
    capture.release()
    cv2.setNumThreads(1)
    reports = []
    for name, size, classes in [('football-role-detector.pt', 960, None),
                                 ('yolo-football-ball-detection.pt', 1280, None)]:
        model = YOLO(root / 'tools' / 'tracking' / name)
        if args.bind_callback:
            bind_detector_cpu_threads(model, int(args.threads.split(',')[0]))
        torch.set_num_threads(3)
        model.predict(frames[0], imgsz=size, conf=.03, device='cpu', verbose=False)
        reference = None
        for threads in map(int, args.threads.split(',')):
            if args.bind_callback:
                bind_detector_cpu_threads(model, threads)
            torch.set_num_threads(threads)
            model.predict(frames[0], imgsz=size, conf=.03, device='cpu', verbose=False)
            timings, boxes = [], []
            for _ in range(args.repeats):
                for frame in frames:
                    start = time.perf_counter()
                    result = model.predict(frame, imgsz=size, conf=.03, classes=classes,
                                           device='cpu', verbose=False)[0]
                    timings.append(time.perf_counter() - start)
                    boxes.append(result.boxes.data.cpu().numpy().copy())
            if reference is None:
                reference = boxes
            equivalent = all(a.shape == b.shape and np.allclose(a, b, rtol=1e-4, atol=.03)
                             for a, b in zip(reference, boxes))
            report = {'model': name, 'imageSize': size, 'threads': threads,
                      'medianSeconds': round(statistics.median(timings), 4),
                      'meanSeconds': round(statistics.mean(timings), 4),
                      'equivalentDetections': equivalent, 'samples': len(timings),
                      'actualThreads': torch.get_num_threads()}
            reports.append(report)
            print(json.dumps(report), flush=True)
    print(json.dumps({'torch': torch.__version__, 'cuda': torch.cuda.is_available(),
                      'reports': reports}), flush=True)


if __name__ == '__main__':
    main()

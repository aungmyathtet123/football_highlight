"""Detect broadcast cuts once; cuts are not football incident boundaries."""
import argparse
import json
import os
import subprocess
from pathlib import Path
from scenedetect import open_video, SceneManager, AdaptiveDetector, ContentDetector
from tracking_cache import atomic_json, fingerprint
from shot_proxy import SHOT_BOUNDARY_VERSION, serialized_shot_fingerprint, shot_proxy_args, validate_shot_proxy_timing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_PATH", "ffmpeg"))
    parser.add_argument("--spatial-proxy", action="store_true", help="Opt-in cut-analysis proxy benchmark")
    parser.add_argument("--native-decode", action="store_true", help="Diagnostic comparison only")
    args = parser.parse_args()
    use_proxy = args.spatial_proxy and not args.native_decode
    signature = {"source": serialized_shot_fingerprint(fingerprint(args.source)), "version": SHOT_BOUNDARY_VERSION,
                 "detector": "adaptive+content-27-pyav", "spatialProxy": use_proxy}
    path = Path(args.output)
    if path.exists():
        previous = json.loads(path.read_text(encoding="utf-8"))
        if previous.get("signature") == signature:
            print("Reused broadcast shot boundaries", flush=True)
            return
    # OpenCV can report a valid video stream but stop after its first frame
    # (observed with an AV1-in-MP4 football upload). PyAV uses FFmpeg's
    # demuxer/decoder and preserves source presentation timestamps.
    original = open_video(args.source, backend="pyav")
    expected_duration = original.duration.seconds
    source_fps = float(original.frame_rate)
    video = original
    # PySceneDetect previously converted every full-HD AV1 frame to RGB and
    # only THEN resized it. A low-resolution H264 analysis proxy avoids that
    # full-HD RGB cost. Never change FPS, playback speed, source or edit bounds.
    if use_proxy and original.frame_size[0] > 480:
        path.parent.mkdir(parents=True, exist_ok=True)
        proxy = path.parent / "shot-proxy-v4.mp4"
        ready = path.parent / "shot-proxy-v4.ready.json"
        reusable = False
        try:
            reusable = json.loads(ready.read_text(encoding="utf-8")) == signature and proxy.stat().st_size > 1024
        except (OSError, ValueError):
            pass
        if not reusable:
            print("Preparing small cut-analysis proxy without changing source timing", flush=True)
            subprocess.run([args.ffmpeg, *shot_proxy_args(args.source, proxy)], check=True,
                           capture_output=True, timeout=max(600, expected_duration * 2))
        video = open_video(str(proxy), backend="pyav")
        validate_shot_proxy_timing(expected_duration, video.duration.seconds, source_fps, float(video.frame_rate))
        atomic_json(ready, signature)
    manager = SceneManager()
    manager.add_detector(AdaptiveDetector(min_scene_len=8))
    # Adaptive ratios can miss a cut surrounded by rapid football motion.
    # The absolute content detector complements it at its default threshold.
    manager.add_detector(ContentDetector(threshold=27, min_scene_len=8))
    manager.auto_downscale = True
    manager.detect_scenes(video, show_progress=False)
    shots = [{"startTime": start.seconds, "endTime": end.seconds,
              "startFrame": start.frame_num, "endFrame": end.frame_num}
             for start, end in manager.get_scene_list(start_in_scene=True)]
    decoded_duration = shots[-1]["endTime"] if shots else 0.0
    if expected_duration > 1 and decoded_duration < expected_duration * 0.9:
        raise RuntimeError(
            f"Broadcast-shot decoder stopped at {decoded_duration:.2f}s of "
            f"{expected_duration:.2f}s; refusing to cache an incomplete ledger"
        )
    atomic_json(path, {"signature": signature, "shots": shots})
    print(f"Indexed {len(shots)} broadcast shots", flush=True)


if __name__ == "__main__":
    main()

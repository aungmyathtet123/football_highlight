"""Detect broadcast cuts once; cuts are not football incident boundaries."""
import argparse
from pathlib import Path
from scenedetect import open_video, SceneManager, AdaptiveDetector, ContentDetector
from tracking_cache import atomic_json, fingerprint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    signature = {"source": fingerprint(args.source), "version": 2, "detector": "adaptive+content-27"}
    path = Path(args.output)
    if path.exists():
        import json
        previous = json.loads(path.read_text(encoding="utf-8"))
        if previous.get("signature") == signature:
            print("Reused broadcast shot boundaries", flush=True)
            return
    video = open_video(args.source)
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
    atomic_json(path, {"signature": signature, "shots": shots})
    print(f"Indexed {len(shots)} broadcast shots", flush=True)


if __name__ == "__main__":
    main()

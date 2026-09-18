"""Run the official SoccerNet CALF external-video action spotter and normalize its output."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import sys


def normalize_predictions(payload: dict) -> list[dict]:
    anchors = []
    for item in payload.get("predictions", []):
        try:
            position_ms = int(item["position"])
            confidence = float(item["confidence"])
        except (KeyError, TypeError, ValueError):
            continue
        anchors.append({
            "timeSeconds": round(position_ms / 1000.0, 3),
            "label": str(item.get("label", "Unknown")),
            "confidence": round(max(0.0, min(1.0, confidence)), 6),
        })
    return sorted(anchors, key=lambda item: (item["timeSeconds"], -item["confidence"]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--ffmpeg-dir", required=True)
    parser.add_argument("--cache-dir")
    parser.add_argument("--reuse-predictions", action="store_true")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    output = Path(args.output).resolve()
    repo = Path(args.repo).resolve()
    calf = repo / "Benchmarks" / "CALF"
    predictions = calf / "inference" / "outputs" / "Predictions-v2.json"
    model = calf / "models" / "CALF_benchmark" / "model.pth.tar"
    if not source.is_file() or not model.is_file():
        raise FileNotFoundError("SoccerNet source video or CALF_benchmark weights are missing")

    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    content_sha256 = digest.hexdigest()
    cache_path = Path(args.cache_dir).resolve() / f"{content_sha256}.json" if args.cache_dir else None
    if cache_path and cache_path.is_file() and not args.reuse_predictions:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        normalized = {
            "version": 1,
            "detector": "SoccerNet CALF_benchmark",
            "contentSha256": content_sha256,
            "source": {"path": str(source), "size": str(source.stat().st_size), "mtimeNs": str(source.stat().st_mtime_ns)},
            "anchors": cached["anchors"],
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(normalized, indent=2), encoding="utf-8")
        print(json.dumps({"output": str(output), "anchorCount": len(normalized["anchors"]), "cacheHit": True}))
        return 0
    if not args.reuse_predictions:
        predictions.unlink(missing_ok=True)
        # Git checks out CALF's Linux Features symlink as a text file on some
        # Windows systems. Materialize only the two official PCA assets needed
        # by external-video inference.
        inference_features = calf / "inference" / "Features"
        if inference_features.is_file():
            target = inference_features.read_text(encoding="utf-8").strip()
            if target != "../../../Features/":
                raise RuntimeError("Unexpected CALF inference/Features placeholder")
            inference_features.unlink()
        inference_features.mkdir(exist_ok=True)
        for name in ("pca_512_TF2.pkl", "average_512_TF2.pkl"):
            destination = inference_features / name
            if not destination.is_file():
                shutil.copy2(repo / "Features" / name, destination)

        os.environ["PYTHONPATH"] = str(repo) + os.pathsep + os.environ.get("PYTHONPATH", "")
        os.environ["PATH"] = str(Path(args.ffmpeg_dir).resolve()) + os.pathsep + os.environ.get("PATH", "")
        sys.path.insert(0, str(calf / "inference"))
        sys.path.insert(0, str(repo))

        # The official 2020 external-video entrypoint hard-codes .cuda(). Keep
        # the model and tensors on CPU without changing its architecture or
        # pretrained weights.
        import torch
        torch.Tensor.cuda = lambda tensor, *unused_args, **unused_kwargs: tensor
        torch.nn.Module.cuda = lambda module, *unused_args, **unused_kwargs: module
        original_dataloader = torch.utils.data.DataLoader
        torch.utils.data.DataLoader = lambda *loader_args, **loader_kwargs: original_dataloader(
            *loader_args, **(loader_kwargs | {"num_workers": 0, "pin_memory": False})
        )
        original_load = torch.load
        torch.load = lambda *load_args, **load_kwargs: original_load(
            *load_args, **({"map_location": "cpu"} | load_kwargs)
        )
        previous_cwd = Path.cwd()
        previous_argv = sys.argv[:]
        try:
            os.chdir(calf)
            sys.argv = ["inference/main.py", "--video_path", str(source), "--model_name", "CALF_benchmark", "--GPU", "-1"]
            runpy.run_path(str(calf / "inference" / "main.py"), run_name="__main__")
        finally:
            sys.argv = previous_argv
            os.chdir(previous_cwd)

    if not predictions.is_file():
        raise FileNotFoundError("CALF did not produce Predictions-v2.json")
    normalized = {
        "version": 1,
        "detector": "SoccerNet CALF_benchmark",
        "contentSha256": content_sha256,
        "source": {"path": str(source), "size": str(source.stat().st_size), "mtimeNs": str(source.stat().st_mtime_ns)},
        "anchors": normalize_predictions(json.loads(predictions.read_text(encoding="utf-8"))),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(normalized, indent=2), encoding="utf-8")
    if cache_path:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps({"version": 1, "detector": normalized["detector"], "contentSha256": content_sha256, "anchors": normalized["anchors"]}, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output), "anchorCount": len(normalized["anchors"]), "cacheHit": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

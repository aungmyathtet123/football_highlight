"""Bound inference threads after YOLO device setup, without changing evidence."""
import os


def detector_cpu_threads(logical_cpus=None, workers=2, override=0):
    logical_cpus = logical_cpus or os.cpu_count() or 2
    if not isinstance(workers, int) or workers < 1:
        raise ValueError('CPU detector worker count must be positive')
    if not isinstance(override, int) or override < 0 or override > 32:
        raise ValueError('TRACKING_CPU_THREADS must be between 0 (auto) and 32')
    if override:
        return min(override, max(1, logical_cpus))
    # Leave room for FFmpeg/UI; more logical threads can slow small YOLO ROIs.
    return max(1, min(4, logical_cpus // (2 * workers)))


def bind_detector_cpu_threads(model, threads):
    if not isinstance(threads, int) or threads < 1:
        raise ValueError('Invalid detector CPU thread budget')
    def apply(predictor):
        if getattr(getattr(predictor, 'device', None), 'type', None) == 'cpu':
            import torch
            if torch.get_num_threads() != threads:
                torch.set_num_threads(threads)
    # YOLO's select_device resets torch threads while initializing each model.
    # This supported hook runs AFTER setup and BEFORE warmup/inference, including
    # new close-up detectors and separate ball models. Do not monkey-patch YOLO.
    model.add_callback('on_predict_start', apply)
    return model

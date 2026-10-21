"""Offline metrics, run only by the research team against held-out references (never exposed to clinicians).
Distances are in working-image pixels."""
import cv2
import numpy as np
from scipy import ndimage as ndi

VERSION = "metrics_v1"


def dice(a, b):
    a, b = a > 0, b > 0
    s = a.sum() + b.sum()
    return 1.0 if s == 0 else float(2 * (a & b).sum() / s)


def iou(a, b):
    a, b = a > 0, b > 0
    u = (a | b).sum()
    return 1.0 if u == 0 else float((a & b).sum() / u)


def _surface_distances(a, b):
    a, b = a > 0, b > 0
    if not a.any() or not b.any():
        return None
    sa, sb = a & ~ndi.binary_erosion(a), b & ~ndi.binary_erosion(b)
    return np.concatenate([ndi.distance_transform_edt(~sb)[sa], ndi.distance_transform_edt(~sa)[sb]])


def hd95(a, b):
    d = _surface_distances(a, b)
    return float("nan") if d is None else float(np.percentile(d, 95))


def assd(a, b):
    d = _surface_distances(a, b)
    return float("nan") if d is None else float(d.mean())


def fp_components(pred, ref):
    """Predicted connected components that do not touch the reference."""
    n, lab = cv2.connectedComponents((pred > 0).astype(np.uint8))
    return int(sum(1 for i in range(1, n) if not ((lab == i) & (ref > 0)).any()))

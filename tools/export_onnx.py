"""Export a SYNCARE model pair to ONNX for in-browser inference and check parity against PyTorch.

  unet.onnx     input  image  (1,3,256,256) float in [0,1]            output prob (1,1,256,256)
                (normalization with the checkpoint's mean/std and the sigmoid are inside the graph)
  refiner.onnx  inputs image  (1,3,256,256) in [0,1]
                       prev   (1,1,256,256) previous probability map
                       points (1,2*K,3)     RITM layout [pos_1..pos_K, neg_1..neg_K] of (y, x, click_index), -1 = padding
                output prob   (1,1,256,256)

K is fixed (default 24 clicks per sign) because padding with -1 is part of the RITM layout.
Run in the syncare env:  python tools/export_onnx.py --seg-ckpt M0.pt [--refiner-ckpt r.pt] --out build/M0
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

SYN = Path("/home/blam5/NW/syncare-cvpr")
sys.path.insert(0, str(SYN / "src"))
sys.path.insert(0, str(SYN / "third_party" / "supervisely_ritm"))
S, K = 256, 24


class UnetWrap(nn.Module):
    def __init__(self, net, mean, std):
        super().__init__()
        self.net = net
        self.register_buffer("mean", torch.as_tensor(mean, dtype=torch.float32).view(1, 3, 1, 1))
        self.register_buffer("std", torch.as_tensor(std, dtype=torch.float32).view(1, 3, 1, 1))

    def forward(self, image):
        return torch.sigmoid(self.net((image - self.mean) / self.std))


class RefinerWrap(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, image, prev, points):
        return torch.sigmoid(self.net(torch.cat([image, prev], 1), points)["instances"])


def functional_coord_features(self, points, batchsize, rows, cols):
    """Same math as isegm DistMaps.get_coord_features (non-disk mode) without in-place indexed writes, so it traces."""
    n2 = points.shape[1]
    p = points[..., :2]
    invalid = (p.max(dim=-1).values < 0).view(batchsize, n2, 1, 1)
    norm = 1.0 if self.use_disks else self.norm_radius * self.spatial_scale
    r = torch.arange(rows, dtype=torch.float32).view(1, 1, rows, 1)
    c = torch.arange(cols, dtype=torch.float32).view(1, 1, 1, cols)
    dy = (r - (p[..., 0] * self.spatial_scale).view(batchsize, n2, 1, 1)) / norm
    dx = (c - (p[..., 1] * self.spatial_scale).view(batchsize, n2, 1, 1)) / norm
    d = torch.where(invalid, torch.full_like(dy * dx, 1e6), dy * dy + dx * dx)
    d = d.view(batchsize, 2, n2 // 2, rows, cols).min(dim=2).values
    if self.use_disks:  # this checkpoint family uses disks of radius norm_radius pixels
        return (d <= (self.norm_radius * self.spatial_scale) ** 2).float()
    return torch.tanh(torch.sqrt(d) * 2)


def points_tensor(clicks):
    """clicks: list of (y, x, sign) in the 256 frame -> (1, 2K, 3) RITM layout padded with -1."""
    pos = [(y, x, i) for i, (y, x, s) in enumerate(clicks) if s == 1]
    neg = [(y, x, i) for i, (y, x, s) in enumerate(clicks) if s == 0]
    assert len(pos) <= K and len(neg) <= K
    rows = pos + [(-1, -1, -1)] * (K - len(pos)) + neg + [(-1, -1, -1)] * (K - len(neg))
    return np.asarray([rows], np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seg-ckpt", required=True)
    ap.add_argument("--refiner-ckpt", default=None)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    import onnxruntime as ort
    import segmentation_models_pytorch as smp
    from syncare.models.segmenter import RITMRefiner

    ck = torch.load(a.seg_ckpt, map_location="cpu", weights_only=False)
    net = smp.Unet(ck["encoder"], encoder_weights=None, classes=1)
    net.load_state_dict(ck["state_dict"])
    unet = UnetWrap(net, ck["mean"], ck["std"]).eval()
    ref = RITMRefiner("hrnet18s", "cpu")
    if a.refiner_ckpt:
        ref.net.load_state_dict(torch.load(a.refiner_ckpt, map_location="cpu", weights_only=False)["state_dict"])
    ref.net.eval()
    refiner = RefinerWrap(ref.net).eval()

    rng = np.random.default_rng(0)
    img = torch.from_numpy(rng.random((1, 3, S, S), dtype=np.float32))
    prev = torch.from_numpy(rng.random((1, 1, S, S), dtype=np.float32))
    pts = torch.from_numpy(points_tensor([(100, 120, 1), (60, 70, 0), (150, 30, 1)]))
    refs = {}
    for cl in ([(100, 120, 1)], [(100, 120, 1), (60, 70, 0)], [(10, 10, 0)] * 2 + [(200, 40, 1)] * 5):
        with torch.no_grad():
            refs[len(cl)] = (cl, torch.sigmoid(ref.net(torch.cat([img, prev], 1), torch.from_numpy(points_tensor(cl)))
                                               ["instances"]).numpy())
    from isegm.model.ops import DistMaps
    DistMaps.get_coord_features = functional_coord_features
    torch.onnx.export(unet, (img,), str(out / "unet.onnx"), input_names=["image"], output_names=["prob"], opset_version=17)
    torch.onnx.export(refiner, (img, prev, pts), str(out / "refiner.onnx"), input_names=["image", "prev", "points"],
                      output_names=["prob"], opset_version=17)

    with torch.no_grad():
        ok = True
        s1 = ort.InferenceSession(str(out / "unet.onnx"), providers=["CPUExecutionProvider"])
        d = np.abs(s1.run(None, {"image": img.numpy()})[0] - unet(img).numpy()).max()
        print(f"unet max abs diff {d:.2e}")
        ok &= d < 1e-3
        s2 = ort.InferenceSession(str(out / "refiner.onnx"), providers=["CPUExecutionProvider"])
        for n, (cl, r) in refs.items():
            o = s2.run(None, {"image": img.numpy(), "prev": prev.numpy(), "points": points_tensor(cl)})[0]
            d = np.abs(o - r).max()
            print(f"refiner ({len(cl)} clicks) max abs diff vs original PyTorch {d:.2e}")
            ok &= d < 1e-3
    print("PARITY OK" if ok else "PARITY FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

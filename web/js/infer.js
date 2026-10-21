// In-browser model inference with onnxruntime-web (single-thread wasm in a worker). Matches tools/export_onnx.py:
//   unet:    image (1,3,256,256) in [0,1]                          -> prob (1,1,256,256)
//   refiner: image, prev (1,1,256,256), points (1,2K,3)            -> prob (1,1,256,256)
// Clicks are in working-image pixels; the models see a 256 x 256 resize (bilinear, same sampling rule as OpenCV INTER_LINEAR).
import { downloadModelFile, sha256Blob } from "./api.js";

export const S = 256, K = 24;
const ORT_VERSION = "1.19.2";

export function resizeRGBA(rgba, w, h, ow, oh) {
  // returns Float32Array (3, oh, ow) in [0,1]
  const out = new Float32Array(3 * oh * ow);
  const sx = w / ow, sy = h / oh;
  for (let i = 0; i < oh; i++) {
    let fy = (i + 0.5) * sy - 0.5, y0, y1;
    if (fy < 0) fy = 0;
    y0 = Math.floor(fy); if (y0 >= h - 1) { y0 = h - 1; y1 = y0; fy = 0; } else y1 = y0 + 1;
    const wy = fy - y0;
    for (let j = 0; j < ow; j++) {
      let fx = (j + 0.5) * sx - 0.5, x0, x1;
      if (fx < 0) fx = 0;
      x0 = Math.floor(fx); if (x0 >= w - 1) { x0 = w - 1; x1 = x0; fx = 0; } else x1 = x0 + 1;
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const a = rgba[(y0 * w + x0) * 4 + c], b = rgba[(y0 * w + x1) * 4 + c];
        const d = rgba[(y1 * w + x0) * 4 + c], e = rgba[(y1 * w + x1) * 4 + c];
        out[(c * oh + i) * ow + j] = ((a * (1 - wx) + b * wx) * (1 - wy) + (d * (1 - wx) + e * wx) * wy) / 255;
      }
    }
  }
  return out;
}

export function upsampleMask(prob, w, h) {
  // 256 x 256 float prob -> w x h binary mask (Uint8Array 0/1), bilinear then > 0.5
  const m = new Uint8Array(w * h), sx = S / w, sy = S / h;
  for (let i = 0; i < h; i++) {
    let fy = (i + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
    let y0 = Math.floor(fy), y1 = y0 + 1; if (y0 >= S - 1) { y0 = S - 1; y1 = S - 1; fy = 0; }
    const wy = fy - y0;
    for (let j = 0; j < w; j++) {
      let fx = (j + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
      let x0 = Math.floor(fx), x1 = x0 + 1; if (x0 >= S - 1) { x0 = S - 1; x1 = S - 1; fx = 0; }
      const wx = fx - x0;
      const v = (prob[y0 * S + x0] * (1 - wx) + prob[y0 * S + x1] * wx) * (1 - wy) + (prob[y1 * S + x0] * (1 - wx) + prob[y1 * S + x1] * wx) * wy;
      m[i * w + j] = v > 0.5 ? 1 : 0;
    }
  }
  return m;
}

let ortReady = null;
function loadOrt() {
  if (ortReady) return ortReady;
  ortReady = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.js`;
    s.onload = () => {
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
      ort.env.wasm.numThreads = 1;  // GitHub Pages cannot send the headers that multi-threaded wasm needs
      ort.env.wasm.proxy = true;    // run in a worker so the page stays responsive
      res(window.ort);
    };
    s.onerror = () => rej(new Error("could not load the inference runtime"));
    document.head.appendChild(s);
  });
  return ortReady;
}

async function cachedFetch(key, fetcher) {
  try {
    const c = await caches.open("syncare-models-v1");
    const hit = await c.match(key);
    if (hit) return await hit.blob();
    const blob = await fetcher();
    await c.put(key, new Response(blob));
    return blob;
  } catch (e) {
    return fetcher();
  }
}

async function loadFile(code, spec, onProgress) {
  // large files are stored as parts below the storage upload limit; join and verify
  const blob = await cachedFetch(`/m/${code}/${spec.sha256}`, async () => {
    const parts = [];
    for (let i = 0; i < spec.parts.length; i++) {
      parts.push(await downloadModelFile(code, spec.parts[i]));
      onProgress && onProgress((i + 1) / spec.parts.length);
    }
    return new Blob(parts);
  });
  if ((await sha256Blob(blob)) !== spec.sha256) {
    try { await (await caches.open("syncare-models-v1")).delete(`/m/${code}/${spec.sha256}`); } catch (e) { /* ignore */ }
    throw new Error("model file failed its integrity check");
  }
  return new Uint8Array(await blob.arrayBuffer());
}

// At most two models stay in memory (the current case's and the next case's), since each takes a few hundred MB.
const engines = new Map();
const MAX_ENGINES = 2;
export async function getEngine(code, onProgress) {
  if (engines.has(code)) { const e = engines.get(code); engines.delete(code); engines.set(code, e); return e; }
  const ort = await loadOrt();
  const man = JSON.parse(await (await downloadModelFile(code, "manifest.json")).text());
  const prog = [0, 0], report = () => onProgress && onProgress((prog[0] * man.unet.size + prog[1] * man.refiner.size) / (man.unet.size + man.refiner.size));
  const [u, r] = await Promise.all([
    loadFile(code, man.unet, p => { prog[0] = p; report(); }),
    loadFile(code, man.refiner, p => { prog[1] = p; report(); }),
  ]);
  const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  const eng = new Engine(ort, await ort.InferenceSession.create(u, opts), await ort.InferenceSession.create(r, opts));
  engines.set(code, eng);
  while (engines.size > MAX_ENGINES) {
    const [oldCode, old] = engines.entries().next().value;
    engines.delete(oldCode);
    try { old.unet.release(); old.refiner.release(); } catch (e) { /* freed with the page anyway */ }
  }
  return eng;
}

class Engine {
  constructor(ort, unet, refiner) { this.ort = ort; this.unet = unet; this.refiner = refiner; }

  prepare(rgba, w, h) { return resizeRGBA(rgba, w, h, S, S); }

  // ort.env.wasm.proxy hands each input buffer to a worker, which detaches it here. Always pass copies, so the
  // image and the stored probability maps stay usable for the next click, undo and replay.
  async initialProb(imgSmall) {
    const out = await this.unet.run({ image: new this.ort.Tensor("float32", imgSmall.slice(), [1, 3, S, S]) });
    return Float32Array.from(out.prob.data);
  }

  pointsTensor(clicks, w, h) {
    // clicks: [{x, y, sign}] in working-image px -> RITM layout [pos_1..pos_K, neg_1..neg_K] of (y, x, click_index), -1 = padding
    const pos = [], neg = [];
    clicks.forEach((c, i) => (c.sign ? pos : neg).push([c.y * S / h, c.x * S / w, i]));
    if (pos.length > K || neg.length > K) throw new Error(`at most ${K} clicks of each sign per case`);
    const rows = [...pos, ...Array(K - pos.length).fill([-1, -1, -1]), ...neg, ...Array(K - neg.length).fill([-1, -1, -1])];
    return new this.ort.Tensor("float32", Float32Array.from(rows.flat()), [1, 2 * K, 3]);
  }

  async refineStep(imgSmall, prevProb, clicks, w, h) {
    const out = await this.refiner.run({
      image: new this.ort.Tensor("float32", imgSmall.slice(), [1, 3, S, S]),
      prev: new this.ort.Tensor("float32", prevProb.slice(), [1, 1, S, S]),
      points: this.pointsTensor(clicks, w, h),
    });
    return Float32Array.from(out.prob.data);
  }
}

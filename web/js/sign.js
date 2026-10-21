// Signature pad: draw with mouse, pen or finger. Returns a PNG blob; blank pads are rejected by the caller via isEmpty().
export class SignaturePad {
  constructor(canvas) {
    this.c = canvas; this.x = canvas.getContext("2d"); this.drawing = false; this.strokes = 0;
    const fit = () => { const r = canvas.getBoundingClientRect(), k = devicePixelRatio || 1; canvas.width = r.width * k; canvas.height = r.height * k; this.x.scale(k, k); this.paint(); };
    this.fit = fit; fit();
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", e => { this.drawing = true; this.strokes++; canvas.setPointerCapture(e.pointerId); this.last = this.pos(e); this.dot(this.last); });
    canvas.addEventListener("pointermove", e => { if (!this.drawing) return; const p = this.pos(e); this.line(this.last, p); this.last = p; });
    const end = () => { this.drawing = false; this.onchange && this.onchange(); };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
  }
  pos(e) { const r = this.c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  paint() { const r = this.c.getBoundingClientRect(); this.x.fillStyle = "#fff"; this.x.fillRect(0, 0, r.width, r.height); this.x.strokeStyle = "#ddd8e8"; this.x.beginPath(); this.x.moveTo(12, r.height - 28); this.x.lineTo(r.width - 12, r.height - 28); this.x.stroke(); this.strokes = 0; }
  dot(p) { this.x.fillStyle = "#1d1b24"; this.x.beginPath(); this.x.arc(p.x, p.y, 1.2, 0, 7); this.x.fill(); }
  line(a, b) { this.x.strokeStyle = "#1d1b24"; this.x.lineWidth = 2.2; this.x.lineCap = "round"; this.x.beginPath(); this.x.moveTo(a.x, a.y); this.x.lineTo(b.x, b.y); this.x.stroke(); }
  clear() { this.paint(); this.onchange && this.onchange(); }
  isEmpty() { return this.strokes < 1; }
  toBlob() { return new Promise(res => this.c.toBlob(res, "image/png")); }
}

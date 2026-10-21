// Clinician workflow. Loading and model computation happen before a case starts, the clock runs from the first outline to the
// decision click (not through ratings, loading or breaks), and every action is logged through the RPC functions.
import * as api from "./api.js";
import { CONFIG } from "../config.js";
import { getEngine, upsampleMask, S } from "./infer.js";

const $ = id => document.getElementById(id);
const cv = $("cv"), cx = cv.getContext("2d");
const hasFilter = "filter" in cx;
const BREAK_REMINDER_MS = 25 * 60 * 1000;
const COLORS = ["#ffd60a", "#22d3ee", "#ff4fd8", "#7CFC00"];
const PHASE_LABEL = { pilot: "Practice", correction_train: "Batch", randomized_eval: "Evaluation", calibration: "Calibration", delineation: "Drawing", crossover: "Crossover" };

let user = null, helpHtml = "", onSignOut = null;
// current case
let A = null, sid = null, eng = null, W = 0, H = 0, bitmap = null, imgSmall = null, prob0 = null;
let steps = [], clicks = [], curMaskId = null, mask = null, maskCv = null, maskVer = 0, tintCv = null, tintVer = -1;
let outlinePath = null, proposalPath = null, manualMode = false, manualEdited = false, isDraw = false, polyPts = null, hist = [];
// ui state
let tool = "pos", busy = false, paused = false, deciding = false, breakKind = null, breakStart = 0;
let view = { s: 1, x: 0, y: 0 }, drag = null, space = false, stroke = null, hover = null, holdHide = false;
let timerBase = 0, timerStart = 0, lastInput = Date.now(), workedMs = 0, lastTick = Date.now(), remindedAt = 0;
let uploads = [], uploadFailed = false, counter = 0, prog = { done: 0, total: 0 }, prefetch = null, curGroup = null, sittingStart = Date.now();
let disp = loadDisp(), stageColor = "#0a0910";

function loadDisp() {
  const d = { fill: 10, color: COLORS[0], bright: 100, contrast: 100, outline: true, ghost: false };
  try { Object.assign(d, JSON.parse(localStorage.getItem("syncai-display") || "{}")); } catch (e) { /* defaults */ }
  return d;
}
const saveDisp = () => { try { localStorage.setItem("syncai-display", JSON.stringify(disp)); } catch (e) { /* ignore */ } };

export function initWork(u, help, signOut) { user = u; helpHtml = help; onSignOut = signOut; wireOnce(); }

// ---------------------------------------------------------------- helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newId = () => `${sid}_m${Date.now().toString(36)}${(counter++).toString(36)}`;
async function retry(fn, tries = 4) { let last; for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await sleep(600 * (i + 1)); } } throw last; }
function toast(msg, ms = 4500) { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = "none", ms); }
function setBusy(b, label) { busy = b; $("busy").style.display = b ? "flex" : "none"; if (label) $("busytext").textContent = label; refreshButtons(); }
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const modal = (html, init) => { $("mbox").innerHTML = html; $("modal").style.display = "flex"; init && init(); };
const closeModal = () => { $("modal").style.display = "none"; };

function gate(title, bodyHtml, buttons) {
  return new Promise(res => {
    $("gtitle").textContent = title; $("gbody").innerHTML = bodyHtml; $("gbtns").innerHTML = "";
    for (const b of buttons) {
      const el = document.createElement("button"); el.textContent = b.label; if (b.primary) el.className = "primary";
      el.onclick = () => { $("gate").style.display = "none"; res(b.value); }; $("gbtns").appendChild(el);
    }
    $("gate").style.display = "flex";
  });
}

function maskToCanvas(m) {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"), d = x.createImageData(W, H);
  for (let i = 0; i < m.length; i++) if (m[i]) { d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = 255; d.data[i * 4 + 3] = 255; }
  x.putImageData(d, 0, 0);
  return c;
}
function canvasToMask(c) {
  const d = c.getContext("2d").getImageData(0, 0, W, H).data, m = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return m;
}
function maskToBlob(m) {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"), d = x.createImageData(W, H);
  for (let i = 0; i < m.length; i++) { const v = m[i] ? 255 : 0; d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v; d.data[i * 4 + 3] = 255; }
  x.putImageData(d, 0, 0);
  return new Promise(res => c.toBlob(res, "image/png"));
}
async function blobToMask(blob) {
  const bmp = await createImageBitmap(blob), c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"); x.drawImage(bmp, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data, m = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4] > 127 ? 1 : 0;
  return m;
}
function queueUpload(maskId, m, kind) {
  const sess = sid;
  uploads.push((async () => {
    const blob = await maskToBlob(m), sha = await api.sha256Blob(blob);
    await retry(() => api.uploadMask(user.uid, sess, maskId, blob));
    await retry(() => api.registerMask(sess, maskId, sha, kind));
  })().catch(e => { uploadFailed = true; console.error("mask upload failed", maskId, e); }));
}
async function flushUploads() { await Promise.all(uploads); uploads = []; }

// Boundary of a binary mask as a path along pixel edges, with runs merged. Stroked at constant screen width, so the
// outline stays thin at any zoom.
export function edgePath(m, w, h, Path = Path2D) {
  const p = new Path(), at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : m[y * w + x];
  for (let y = 0; y <= h; y++) {
    let x = 0;
    while (x < w) {
      if (at(x, y - 1) !== at(x, y)) { const x0 = x; while (x < w && at(x, y - 1) !== at(x, y)) x++; p.moveTo(x0, y); p.lineTo(x, y); } else x++;
    }
  }
  for (let x = 0; x <= w; x++) {
    let y = 0;
    while (y < h) {
      if (at(x - 1, y) !== at(x, y)) { const y0 = y; while (y < h && at(x - 1, y) !== at(x, y)) y++; p.moveTo(x, y0); p.lineTo(x, y); } else y++;
    }
  }
  return p;
}
function setMask(m, fromStroke) {
  mask = m; if (!fromStroke) maskCv = maskToCanvas(m);
  maskVer++; outlinePath = edgePath(m, W, H); draw(); refreshButtons();
}

// ---------------------------------------------------------------- loading
async function loadCaseData(a, report) {
  const drawing = a.phase === "delineation";  // timed drawing cases need no model
  const e = drawing ? null : await getEngine(a.blind_code, report);
  const bmp = await createImageBitmap(await api.downloadCase(a.image_path));
  if (drawing) return { a, eng: null, bitmap: bmp, imgSmall: null, prob0: null };
  const tmp = document.createElement("canvas"); tmp.width = a.width; tmp.height = a.height;
  const tx = tmp.getContext("2d"); tx.drawImage(bmp, 0, 0, a.width, a.height);
  const small = e.prepare(tx.getImageData(0, 0, a.width, a.height).data, a.width, a.height);
  return { a, eng: e, bitmap: bmp, imgSmall: small, prob0: await e.initialProb(small) };
}

const inBatch = a => a.batch_index > 0 && (a.phase === "correction_train" || a.phase === "delineation");
function groupKey(a) { return inBatch(a) ? `batch:${a.batch_index}` : `${a.phase}:${a.batch_index}`; }
function groupLabel(a) { return inBatch(a) ? `Batch ${a.batch_index}` : (PHASE_LABEL[a.phase] || a.phase); }
const INTRO = {
  pilot: "These practice cases let you learn the tool. They are recorded but are not part of the main analysis.",
  correction_train: "Correct the outline with a few clicks, or draw it yourself if clicks are not enough. Accept when it is clinically acceptable.",
  randomized_eval: "Same task as before. You will not be told which model made each outline.",
  calibration: "Same task as before.", delineation: "Draw the whole outline yourself with Polygon or Draw. The clock runs in the same way.",
};

export async function nextCase() {
  $("app").style.display = "block"; $("gate").style.display = "none";
  setBusy(true, "Loading");
  try {
    const [rows, all] = await Promise.all([api.nextAssignments(2), api.myAssignments()]);
    prog = { done: all.filter(x => x.status === "done").length, total: all.length }; updateProgress(all, rows[0]);
    if (!rows.length) { showWaiting(); return; }
    A = rows[0];
    const key = groupKey(A), inGroup = all.filter(x => groupKey(x) === key);
    if (A.status === "pending" && key !== curGroup) {  // a resumed case skips the screen so reloads never block work
      setBusy(false);
      const prev = curGroup && all.filter(x => groupKey(x) === curGroup);
      const outro = prev ? `<p>You finished ${prev.length} cases in the last group.</p>` : "";
      await gate(prev ? `${groupLabel(A)} is ready` : `${groupLabel(A)}: ${inGroup.length} cases`,
        `${outro}<p>${INTRO[A.phase] || ""}</p><p>The timer runs from the moment the outline appears until you press Accept or Flag. Loading, rating and breaks are not counted. ` +
        `You can take a break at any time with the button at the top.</p><p>This group has ${inGroup.length} cases${prev ? "" : ", and you can stop between cases"}.</p>`,
        [{ label: prev ? `Start ${groupLabel(A)}` : "Start", primary: true, value: 1 }]);
      sittingStart = Date.now(); workedMs = 0; setBusy(true, "Loading");
    }
    curGroup = key;
    const pre = prefetch && prefetch.id === A.assignment_id ? await prefetch.promise : null;
    prefetch = null;
    const d = pre || await loadCaseData(A, f => $("busytext").textContent = `Loading the model ${Math.round(f * 100)}%`);
    isDraw = A.phase === "delineation";
    eng = isDraw ? null : await getEngine(A.blind_code); bitmap = d.bitmap; imgSmall = d.imgSmall; prob0 = d.prob0; W = A.width; H = A.height;
    const start = await api.startSession(A.assignment_id);
    sid = start.session_id; steps = isDraw ? [] : [{ prob: prob0 }]; clicks = []; manualMode = isDraw; manualEdited = false; deciding = false; polyPts = null;
    uploads = []; uploadFailed = false; curMaskId = start.initial_mask_id;
    proposalPath = isDraw ? null : edgePath(upsampleMask(prob0, W, H), W, H);
    const st = start.state;
    if (start.resumed && st.manual) {
      $("busytext").textContent = "Restoring your work";
      manualMode = manualEdited = true; curMaskId = st.mask_id; mask = await blobToMask(await api.downloadMask(user.uid, sid, st.mask_id));
    } else if (start.resumed && !isDraw) {
      $("busytext").textContent = "Restoring your corrections";
      for (const c of st.clicks) { clicks.push(c); steps.push({ prob: await eng.refineStep(imgSmall, steps[steps.length - 1].prob, clicks, W, H) }); }
      curMaskId = st.mask_id; mask = upsampleMask(steps[steps.length - 1].prob, W, H); queueUpload(curMaskId, mask, "model");
    } else if (isDraw) { mask = new Uint8Array(W * H); queueUpload(curMaskId, mask, "initial"); }
    else { mask = upsampleMask(prob0, W, H); queueUpload(curMaskId, mask, "initial"); }
    hist = manualMode ? [{ mask: mask.slice(), id: curMaskId }] : [];
    tool = isDraw ? "poly" : (manualMode ? "draw" : "pos"); maskCv = maskToCanvas(mask); setMask(mask);
    $("phase").textContent = groupLabel(A) + (isDraw ? " · draw it yourself" : "");
    $("accept").innerHTML = (isDraw ? "Done" : "Accept") + " <kbd>Enter</kbd>";
    if (isDraw && !start.resumed) toast("Timed drawing case: outline the target yourself with Polygon (L) or Draw (D).", 7000);
    resetView(); resetStrip();
    timerBase = 0; timerStart = Date.now(); lastInput = Date.now(); paused = false; $("paused").style.display = "none"; $("pause").textContent = "Take a break";
    if (start.resumed) { await api.logEvent({ session: sid, type: "pause", meta: { reason: "reload" } }); pauseUI(true, "reload"); }
    if (rows[1]) {  // load the next case in the background so there is no wait after this one
      prefetch = { id: rows[1].assignment_id, promise: loadCaseData(rows[1]).catch(e => { console.warn("prefetch failed", e); return null; }) };
    }
  } catch (e) {
    console.error(e);
    alert("Could not load the case: " + e.message + "\nReload the page to try again.");
  }
  setBusy(false);
}

function showWaiting() {
  A = null; sid = null; setBusy(false);
  gate("You are up to date", `<p>You have completed every case released to you so far. If more are expected, the study team will tell you when the next batch is ready.</p>`,
    [{ label: "Check again", primary: true, value: "again" }, { label: "Sign out", value: "out" }]).then(v => { if (v === "again") nextCase(); else onSignOut(); });
}
function updateProgress(all, a) {
  if (a) {
    const g = all.filter(x => groupKey(x) === groupKey(a)), n = g.filter(x => x.status === "done").length + 1;
    $("prog").textContent = `${groupLabel(a)} · case ${Math.min(n, g.length)} of ${g.length}`;
  } else $("prog").textContent = "";
  $("bar").firstElementChild.style.width = (prog.total ? 100 * prog.done / prog.total : 0) + "%";
}

// ---------------------------------------------------------------- drawing and view
function fitCanvas() { cv.width = cv.clientWidth * devicePixelRatio; cv.height = cv.clientHeight * devicePixelRatio; draw(); }
function resetView() {
  fitCanvas();
  const s = Math.min(cv.width / W, cv.height / H) * 0.96;
  view = { s, x: (cv.width - W * s) / 2, y: (cv.height - H * s) / 2 }; draw();
}
function tinted() {
  if (!tintCv || tintCv.width !== W || tintCv.height !== H) { tintCv = document.createElement("canvas"); tintCv.width = W; tintCv.height = H; tintVer = -1; }
  if (tintVer !== maskVer) {
    const t = tintCv.getContext("2d"); t.globalCompositeOperation = "source-over"; t.clearRect(0, 0, W, H);
    t.drawImage(maskCv, 0, 0); t.globalCompositeOperation = "source-in"; t.fillStyle = disp.color; t.fillRect(0, 0, W, H); tintVer = maskVer;
  }
  return tintCv;
}
function draw() {
  if (!bitmap || !A) return;
  cx.setTransform(1, 0, 0, 1, 0, 0); cx.fillStyle = stageColor; cx.fillRect(0, 0, cv.width, cv.height);
  cx.setTransform(view.s, 0, 0, view.s, view.x, view.y); cx.imageSmoothingEnabled = view.s < 3;
  if (hasFilter) cx.filter = `brightness(${disp.bright}%) contrast(${disp.contrast}%)`;
  cx.drawImage(bitmap, 0, 0, W, H); if (hasFilter) cx.filter = "none";
  if (disp.outline && !holdHide) {
    if (disp.fill > 0 && maskCv) { cx.globalAlpha = disp.fill / 100; cx.drawImage(tinted(), 0, 0); cx.globalAlpha = 1; }
    cx.lineJoin = "round"; cx.lineCap = "round";
    if (disp.ghost && proposalPath) { cx.setLineDash([5 / view.s, 4 / view.s]); cx.lineWidth = 1.3 / view.s; cx.strokeStyle = "rgba(255,255,255,.8)"; cx.stroke(proposalPath); cx.setLineDash([]); }
    if (outlinePath && !stroke) { cx.lineWidth = 1.6 / view.s; cx.strokeStyle = disp.color; cx.stroke(outlinePath); }
  }
  if (!manualMode) for (const c of clicks) {
    cx.beginPath(); cx.arc(c.x, c.y, 6 / view.s, 0, 7); cx.fillStyle = c.sign ? "#22c55e" : "#ef4444"; cx.fill();
    cx.lineWidth = 1.8 / view.s; cx.strokeStyle = "#fff"; cx.stroke();
  }
  if (polyPts) {
    cx.lineWidth = 1.6 / view.s; cx.strokeStyle = "#22d3ee"; cx.beginPath();
    polyPts.forEach((q, i) => i ? cx.lineTo(q.x, q.y) : cx.moveTo(q.x, q.y));
    if (hover) cx.lineTo((hover.x - view.x) / view.s, (hover.y - view.y) / view.s);
    cx.stroke();
    polyPts.forEach((q, i) => { cx.beginPath(); cx.arc(q.x, q.y, (i ? 3 : 5) / view.s, 0, 7); cx.fillStyle = i ? "#22d3ee" : "#fff"; cx.fill(); });
  }
  if ((tool === "draw" || tool === "erase") && hover) {
    cx.setTransform(1, 0, 0, 1, 0, 0); cx.beginPath(); cx.arc(hover.x, hover.y, +$("brush").value / 2 * devicePixelRatio, 0, 7);
    cx.lineWidth = 1.5; cx.strokeStyle = tool === "erase" ? "#ff6b6b" : "#fff"; cx.stroke();
  }
}
const toImg = e => { const r = cv.getBoundingClientRect(), k = devicePixelRatio; return { x: ((e.clientX - r.left) * k - view.x) / view.s, y: ((e.clientY - r.top) * k - view.y) / view.s }; };
function paintStroke(a, b) {
  const c = maskCv.getContext("2d"), rad = Math.max(0.5, +$("brush").value / 2 * devicePixelRatio / view.s);
  c.globalCompositeOperation = tool === "draw" ? "source-over" : "destination-out";
  c.fillStyle = c.strokeStyle = "#fff"; c.lineWidth = rad * 2; c.lineCap = "round";
  c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); c.beginPath(); c.arc(b.x, b.y, rad, 0, 7); c.fill();
  c.globalCompositeOperation = "source-over"; maskVer++;
}

// ---------------------------------------------------------------- actions
function refreshButtons() {
  const off = busy || paused || deciding || !A;
  for (const id of ["tpos", "tneg", "undo", "tdraw", "terase", "tpoly", "tcut", "accept", "flag", "pause"]) $(id).disabled = off && !(id === "pause" && !busy && !deciding && !!A);
  if (!off) { $("tpos").disabled = $("tneg").disabled = manualMode; $("undo").disabled = manualMode ? hist.length < 2 : clicks.length === 0; }
  for (const [id, t] of [["tpos", "pos"], ["tneg", "neg"], ["tdraw", "draw"], ["terase", "erase"], ["tpoly", "poly"], ["tcut", "polycut"]]) $(id).classList.toggle("on", tool === t);
  $("brushbox").style.display = tool === "draw" || tool === "erase" ? "block" : "none";
  $("nclicks").textContent = isDraw ? "Timed drawing" : manualMode ? "Drawing mode" : `${clicks.length} click${clicks.length === 1 ? "" : "s"}`;
  $("hint").textContent = tool === "poly" || tool === "polycut" ? "Click corners. Click the first corner or press Enter to close. Backspace removes a corner, Esc cancels." : tool === "draw" || tool === "erase" ? "Draw on the image. Right-drag or Shift-drag to pan, wheel to zoom." : "Click the image to place a point. Right-drag or Shift-drag to pan, wheel to zoom.";
}
async function placeClick(p) {
  if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
  const sign = tool === "pos" ? 1 : 0;
  if (clicks.filter(c => c.sign === sign).length >= 24) { toast("At most 24 clicks of each sign per case. Use Draw or flag the case."); return; }
  setBusy(true, "Updating the outline");
  try {
    const c = { x: p.x, y: p.y, sign }, next = [...clicks, c], t0 = performance.now();
    const prob = await eng.refineStep(imgSmall, steps[steps.length - 1].prob, next, W, H);
    const m = upsampleMask(prob, W, H), latency = performance.now() - t0, id = newId();
    await api.logEvent({ session: sid, type: "click", sign: sign ? "positive" : "negative", x: c.x, y: c.y, before: curMaskId, after: id, latency });
    steps.push({ prob }); clicks = next; curMaskId = id; setMask(m); queueUpload(id, m, "model");
  } catch (e) { toast("Click not saved: " + e.message); }
  setBusy(false);
}
async function undo() {
  if (manualMode) return undoEdit();
  if (!clicks.length || busy || paused || deciding) return;
  setBusy(true, "Updating the outline");
  try {
    const t0 = performance.now(), m = upsampleMask(steps[steps.length - 2].prob, W, H), latency = performance.now() - t0, id = newId();
    await api.logEvent({ session: sid, type: "undo", before: curMaskId, after: id, latency });
    steps.pop(); clicks.pop(); curMaskId = id; setMask(m); queueUpload(id, m, "model");
  } catch (e) { toast("Undo not saved: " + e.message); }
  setBusy(false);
}
const MANUAL_TOOLS = ["draw", "erase", "poly", "polycut"];
function chooseTool(t) {
  if (MANUAL_TOOLS.includes(t) && !manualMode) {
    modal(`<h3 style="margin-top:0">Draw the mask yourself?</h3><p>Clicks are turned off for the rest of this case.</p><div class="row"><button id="mc">Cancel</button><button class="primary" id="mo">Draw</button></div>`, () => {
      $("mc").onclick = closeModal;
      $("mo").onclick = () => { closeModal(); manualMode = true; tool = t; hist = [{ mask: mask.slice(), id: curMaskId }]; refreshButtons(); draw(); };
    }); return;
  }
  if (manualMode && (t === "pos" || t === "neg")) return;
  if (t !== tool) polyPts = null;
  tool = t; refreshButtons(); draw();
}
async function sendManual(points, extraMeta) {
  setBusy(true, "Saving");
  try {
    const m = canvasToMask(maskCv), id = newId();
    await api.logEvent({ session: sid, type: "manual_edit", before: curMaskId, after: id, meta: { tool, brush_screen_px: +$("brush").value, zoom: +view.s.toFixed(3), n_points: points, ...extraMeta } });
    curMaskId = id; manualEdited = true; hist.push({ mask: m, id }); if (hist.length > 40) hist.shift();
    setMask(m, true); queueUpload(id, m, "manual");
  } catch (e) { toast("Edit not saved: " + e.message); }
  setBusy(false);
}
async function undoEdit() {
  if (hist.length < 2 || busy || paused || deciding) return;
  setBusy(true, "Undoing");
  try {
    const prev = hist[hist.length - 2];
    await api.logEvent({ session: sid, type: "edit_undo", before: curMaskId, after: prev.id });
    hist.pop(); curMaskId = prev.id; maskCv = maskToCanvas(prev.mask); setMask(prev.mask, true);
  } catch (e) { toast("Undo not saved: " + e.message); }
  setBusy(false);
}
function addVertex(p) {
  if (!manualMode) return;
  if (!polyPts) { polyPts = [p]; draw(); return; }
  const f = polyPts[0];
  if (polyPts.length >= 3 && Math.hypot((p.x - f.x) * view.s, (p.y - f.y) * view.s) / devicePixelRatio < 10) { closePoly(); return; }
  polyPts.push(p); draw();
}
async function closePoly() {
  if (!polyPts || polyPts.length < 3) return;
  const pts = polyPts; polyPts = null;
  const c = maskCv.getContext("2d");
  c.globalCompositeOperation = tool === "poly" ? "source-over" : "destination-out"; c.fillStyle = "#fff";
  c.beginPath(); pts.forEach((q, i) => i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)); c.closePath(); c.fill(); c.globalCompositeOperation = "source-over";
  maskVer++; await sendManual(pts.length, { n_vertices: pts.length });
}

// ---------------------------------------------------------------- decisions: Accept and Flag stop the clock, then ratings
let decision = null;
async function logDecision(kind) {
  const meta = { outcome: kind, display: { fill: disp.fill, color: disp.color, bright: disp.bright, contrast: disp.contrast, ghost: disp.ghost, theme: document.documentElement.dataset.theme } };
  try { await api.logEvent({ session: sid, type: "decision", meta }); }
  catch (e) {  // database not yet migrated: a pause stops the clock just as well
    if (/not allowed/i.test(e.message)) await api.logEvent({ session: sid, type: "pause", meta: { ...meta, reason: "rating" } }); else throw e;
  }
}
function resetStrip() { $("strip").style.display = "none"; $("strip").innerHTML = ""; $("flag").style.display = ""; $("accept").style.display = ""; $("nclicks").style.display = ""; deciding = false; decision = null; refreshButtons(); }
function freezeTimer() { timerBase += Date.now() - timerStart; }
async function startDecision(kind) {
  if (busy || paused || deciding || !A) return;
  if (kind === "accept" && isDraw && !mask.some(v => v)) { toast("Draw the outline first, or flag the case."); return; }
  setBusy(true, "Saving");
  try { await logDecision(kind); } catch (e) { toast("Could not record the decision: " + e.message); setBusy(false); return; }
  setBusy(false); deciding = true; freezeTimer(); decision = { kind, conf: null, diff: null };
  $("flag").style.display = "none"; $("accept").style.display = "none"; $("nclicks").style.display = "none";
  const st = $("strip"); st.style.display = "flex";
  const scale = (name, label) => `<div class="grp" data-g="${name}"><span>${label}</span>${[1, 2, 3, 4, 5].map(i => `<button data-v="${i}">${i}</button>`).join("")}</div>`;
  if (kind === "accept") st.innerHTML = scale("conf", "Confidence (1 low, 5 high)") + scale("diff", "Difficulty (1 easy, 5 hard)") + `<button id="sback">Back <kbd>Esc</kbd></button>`;
  else st.innerHTML = `<div class="grp"><span>Reason</span>${[["cannot_correct", "Cannot correct"], ["ambiguous_target", "Ambiguous target"], ["poor_image", "Poor image"], ["other", "Other"]].map(([v, l]) => `<button data-reason="${v}" style="width:auto;padding:8px 12px">${l}</button>`).join("")}</div><button id="sback">Back <kbd>Esc</kbd></button>`;
  st.onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "sback") return cancelDecision();
    if (b.dataset.reason) return finish("flag", { note: b.dataset.reason });
    pickRating(b.parentElement.dataset.g, +b.dataset.v);
  };
}
function pickRating(name, v) {
  if (!decision || decision.kind !== "accept") return;
  decision[name] = v;
  $("strip").querySelectorAll(`[data-g="${name}"] button`).forEach(b => b.classList.toggle("on", +b.dataset.v === v));
  if (decision.conf && decision.diff) finish(manualEdited ? "manual_complete" : "accept", { confidence: decision.conf, difficulty: decision.diff });
}
async function cancelDecision() {
  if (!deciding) return;
  try { await api.logEvent({ session: sid, type: "resume", meta: { reason: "cancel_decision" } }); } catch (e) { toast(e.message); return; }
  resetStrip(); timerStart = Date.now(); lastInput = Date.now();
}
async function finish(action, extra) {
  setBusy(true, "Saving");
  try {
    await flushUploads();
    if (uploadFailed) throw new Error("some masks could not be uploaded. Check your connection and try again.");
    await api.finishSession({ session: sid, action, finalMask: curMaskId, ...extra });
    sid = null; A = null; resetStrip(); await nextCase();
  } catch (e) {
    alert("Could not finish this case: " + e.message);
    if (uploadFailed) { uploadFailed = false; queueUpload(curMaskId, mask, manualEdited ? "manual" : "model"); }
    setBusy(false);
  }
}

// ---------------------------------------------------------------- breaks, pause, idle
const touch = () => { lastInput = Date.now(); };
function pauseUI(p, kind) {
  paused = p;
  if (p) {
    freezeTimer(); breakKind = kind || "break"; breakStart = Date.now();
    $("ptitle").textContent = breakKind === "idle" ? "Paused because you were inactive." : breakKind === "reload" ? "Welcome back. Your case is restored." : "On a break. The timer is stopped.";
    $("psub").textContent = breakKind === "break" ? "Take as long as you like. Your place is saved." : "Press the button when you are ready to continue.";
    $("resume").textContent = breakKind === "break" ? "Back to work" : "Continue";
    $("pclock").textContent = "0:00"; $("paused").style.display = "flex";
  } else { $("paused").style.display = "none"; timerStart = Date.now(); if (Date.now() - breakStart > 3 * 60 * 1000) { workedMs = 0; remindedAt = 0; } }
  refreshButtons();
}
async function doPause(kind) {
  if (paused || !sid || busy) return;
  if (deciding) return;  // the clock is already stopped
  pauseUI(true, kind);
  try { await api.logEvent({ session: sid, type: "pause", meta: { reason: kind }, backdate: kind === "idle" ? CONFIG.IDLE_PAUSE_MS / 1000 : 0 }); } catch (e) { console.error(e); }
}
async function doResume() {
  if (!paused || !sid) return;
  try { await api.logEvent({ session: sid, type: "resume" }); } catch (e) { toast("Could not resume: " + e.message); return; }
  pauseUI(false); touch();
}

// ---------------------------------------------------------------- wiring (once)
let wired = false;
function applyDispUI() {
  $("fill").value = disp.fill; $("bright").value = disp.bright; $("contrast").value = disp.contrast;
  $("ov").classList.toggle("on", disp.outline); $("ov").textContent = disp.outline ? "On" : "Off"; $("ghost").classList.toggle("on", disp.ghost);
  $("swatches").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.c === disp.color));
  $("bright").disabled = $("contrast").disabled = !hasFilter;
}
function setTheme(t) { document.documentElement.dataset.theme = t; stageColor = getComputedStyle(document.documentElement).getPropertyValue("--stage").trim() || "#0a0910"; try { localStorage.setItem("syncai-theme", t); } catch (e) { /* ignore */ } $("theme").textContent = t === "dark" ? "Light" : "Dark"; draw(); }

function wireOnce() {
  if (wired) return; wired = true;
  $("swatches").innerHTML = COLORS.map(c => `<button data-c="${c}" style="background:${c}" title="${c}"></button>`).join("");
  applyDispUI(); setTheme(document.documentElement.dataset.theme || "dark");
  $("swatches").onclick = e => { const b = e.target.closest("button"); if (!b) return; disp.color = b.dataset.c; tintVer = -1; saveDisp(); applyDispUI(); draw(); };
  $("fill").oninput = () => { disp.fill = +$("fill").value; saveDisp(); draw(); };
  $("bright").oninput = () => { disp.bright = +$("bright").value; saveDisp(); draw(); };
  $("contrast").oninput = () => { disp.contrast = +$("contrast").value; saveDisp(); draw(); };
  $("dreset").onclick = () => { disp.bright = disp.contrast = 100; saveDisp(); applyDispUI(); draw(); };
  $("ov").onclick = () => { disp.outline = !disp.outline; saveDisp(); applyDispUI(); draw(); };
  $("ghost").onclick = () => { disp.ghost = !disp.ghost; saveDisp(); applyDispUI(); draw(); };
  $("theme").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("fit").onclick = resetView;

  addEventListener("resize", () => { if (A) fitCanvas(); });
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("wheel", e => {
    e.preventDefault(); touch();
    const r = cv.getBoundingClientRect(), k = devicePixelRatio, mx = (e.clientX - r.left) * k, my = (e.clientY - r.top) * k;
    const ns = Math.min(Math.max(view.s * Math.exp(-e.deltaY * 0.0015), 0.2), 40);
    view.x = mx - (mx - view.x) * ns / view.s; view.y = my - (my - view.y) * ns / view.s; view.s = ns; draw();
  }, { passive: false });
  cv.addEventListener("pointerdown", e => {
    touch(); if (busy || paused || deciding || !A) return;
    if (e.button === 2 || e.button === 1 || space || e.shiftKey) { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, pan: true }; cv.setPointerCapture(e.pointerId); return; }
    if (e.button !== 0) return;
    const p = toImg(e);
    if (tool === "draw" || tool === "erase") { if (!manualMode) return; stroke = { pts: 1, last: p }; paintStroke(p, p); cv.setPointerCapture(e.pointerId); draw(); return; }
    drag = { x: e.clientX, y: e.clientY, click: p };
  });
  cv.addEventListener("pointermove", e => {
    touch(); const r = cv.getBoundingClientRect(); hover = { x: (e.clientX - r.left) * devicePixelRatio, y: (e.clientY - r.top) * devicePixelRatio };
    if (stroke) { const p = toImg(e); paintStroke(stroke.last, p); stroke.last = p; stroke.pts++; draw(); return; }
    if (drag && drag.pan) { const k = devicePixelRatio; view.x = drag.vx + (e.clientX - drag.x) * k; view.y = drag.vy + (e.clientY - drag.y) * k; }
    if (A && (tool === "draw" || tool === "erase" || polyPts || (drag && drag.pan))) draw();
  });
  cv.addEventListener("pointerleave", () => { hover = null; if (A) draw(); });
  cv.addEventListener("pointerup", async e => {
    if (stroke) { const n = stroke.pts; stroke = null; await sendManual(n); return; }
    const d = drag; drag = null;
    if (!d || d.pan || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    if (tool === "poly" || tool === "polycut") addVertex(d.click); else await placeClick(d.click);
  });

  $("tpos").onclick = () => chooseTool("pos"); $("tneg").onclick = () => chooseTool("neg");
  $("tdraw").onclick = () => chooseTool("draw"); $("terase").onclick = () => chooseTool("erase");
  $("tpoly").onclick = () => chooseTool("poly"); $("tcut").onclick = () => chooseTool("polycut");
  $("undo").onclick = undo;
  $("accept").onclick = () => startDecision("accept"); $("flag").onclick = () => startDecision("flag");
  $("help").onclick = () => modal(`<div class="doc" style="max-height:60vh;overflow:auto">${helpHtml}</div><div class="row" style="margin-top:12px"><button class="primary" id="mc">Close</button></div>`, () => { $("mc").onclick = closeModal; });
  $("pause").onclick = () => paused ? doResume() : doPause("break");
  $("resume").onclick = doResume;
  $("signout").onclick = async () => {
    if (sid && !confirm("A case is open. Its timer will pause and it will reopen when you sign in again. Sign out?")) return;
    if (sid && !paused && !deciding) await doPause("break");
    onSignOut();
  };

  setInterval(() => {
    const now = Date.now(), dt = now - lastTick; lastTick = now;
    if (paused && $("paused").style.display === "flex") $("pclock").textContent = fmt((now - breakStart) / 1000);
    if (!A || !sid) return;
    const running = !paused && !deciding;
    if (running) workedMs += dt;
    $("timer").textContent = fmt((timerBase + (running ? now - timerStart : 0)) / 1000);
    if (running && workedMs - remindedAt >= BREAK_REMINDER_MS) { remindedAt = workedMs; toast(`${Math.round(workedMs / 60000)} minutes of work. A short break is a good idea; the button is at the top.`, 9000); }
    if (running && !busy && $("modal").style.display !== "flex" && now - lastInput > CONFIG.IDLE_PAUSE_MS) doPause("idle");
  }, 1000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) doPause("break"); });
  addEventListener("beforeunload", e => { if (sid && !window.__leaving) { e.preventDefault(); e.returnValue = ""; } });
  addEventListener("keydown", e => {
    touch();
    if (!A || ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
    if (e.code === "Space") { space = true; e.preventDefault(); return; }
    if ($("modal").style.display === "flex" || $("gate").style.display === "flex" || busy || paused) return;
    const k = e.key.toLowerCase();
    if (deciding) {
      if (e.key === "Escape") cancelDecision();
      else if (decision && decision.kind === "accept" && /^[1-5]$/.test(e.key)) pickRating(decision.conf ? "diff" : "conf", +e.key);
      return;
    }
    if (polyPts) {
      if (e.key === "Enter") { if (polyPts.length >= 3) closePoly(); else toast("A polygon needs at least 3 corners."); return; }
      if (e.key === "Backspace") { polyPts.pop(); if (!polyPts.length) polyPts = null; draw(); return; }
      if (e.key === "Escape") { polyPts = null; draw(); return; }
    }
    if (e.key === "Enter") startDecision("accept");
    else if (k === "p" || k === "+") chooseTool("pos");
    else if (k === "n" || k === "-") chooseTool("neg");
    else if (k === "d") chooseTool("draw");
    else if (k === "e") chooseTool("erase");
    else if (k === "l") chooseTool("poly");
    else if (k === "k") chooseTool("polycut");
    else if (k === "z") undo();
    else if (k === "f") startDecision("flag");
    else if (k === "o") $("ov").click();
    else if (k === "x") $("ghost").click();
    else if (k === "0") resetView();
    else if (k === "h" && !holdHide) { holdHide = true; draw(); }
  });
  addEventListener("keyup", e => { if (e.code === "Space") space = false; if (e.key.toLowerCase() === "h" && holdHide) { holdHide = false; draw(); } });
  addEventListener("mousemove", touch);
}

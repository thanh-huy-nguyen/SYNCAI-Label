// Clinician workflow: load model and image first (not timed), start the session, correct with clicks, decide.
// All model computation runs in this browser. Every action is logged through the RPC functions; masks go to storage.
import * as api from "./api.js";
import { CONFIG } from "../config.js";
import { getEngine, upsampleMask, S } from "./infer.js";

const $ = id => document.getElementById(id);
const cv = $("cv"), cx = cv.getContext("2d");

let user = null, helpHtml = "", onSignOut = null;
let A = null, sid = null, eng = null, W = 0, H = 0, bitmap = null, imgSmall = null;
let steps = [], clicks = [], curMaskId = null, mask = null, maskCv = null, outlineCv = null, tintCv = null;
let tool = "positive", busy = false, paused = false, manual = false, manualEdited = false, showOv = true;
let view = { s: 1, x: 0, y: 0 }, drag = null, space = false, stroke = null, brushMode = "add";
let timerBase = 0, timerStart = 0, lastInput = Date.now(), uploads = [], uploadFailed = false, counter = 0, prog = { done: 0, total: 0 };

export function initWork(u, help, signOut) { user = u; helpHtml = help; onSignOut = signOut; wireOnce(); }

// ---------------------------------------------------------------- helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newId = () => `${sid}_m${Date.now().toString(36)}${(counter++).toString(36)}`;
async function retry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await sleep(600 * (i + 1)); } }
  throw last;
}
function toast(msg, ms = 4000) { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = "none", ms); }
function setBusy(b, label) {
  busy = b; $("busy").style.display = b ? "flex" : "none"; if (label) $("busytext").textContent = label;
  refreshButtons();
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
  const p = (async () => {
    const blob = await maskToBlob(m);
    const sha = await api.sha256Blob(blob);
    await retry(() => api.uploadMask(user.uid, sess, maskId, blob));
    await retry(() => api.registerMask(sess, maskId, sha, kind));
  })().catch(e => { uploadFailed = true; console.error("mask upload failed", maskId, e); });
  uploads.push(p);
}
async function flushUploads() { await Promise.all(uploads); uploads = []; }

function setMask(m) {
  mask = m; maskCv = maskToCanvas(m); buildOutline(); draw(); refreshButtons();
}
function buildOutline() {
  outlineCv = document.createElement("canvas"); outlineCv.width = W; outlineCv.height = H;
  const x = outlineCv.getContext("2d"), d = x.createImageData(W, H), m = mask;
  const on = (i, j) => i >= 0 && j >= 0 && i < H && j < W && m[i * W + j];
  for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) {
    if (m[i * W + j] && !(on(i - 1, j) && on(i + 1, j) && on(i, j - 1) && on(i, j + 1))) {
      const k = (i * W + j) * 4; d.data[k] = 255; d.data[k + 1] = 214; d.data[k + 2] = 10; d.data[k + 3] = 255;
    }
  }
  x.putImageData(d, 0, 0);
}

// ---------------------------------------------------------------- case loading
export async function nextCase() {
  $("app").style.display = "block";
  setBusy(true, "Loading the next case");
  try {
    prog = await api.progress(); updateProgress();
    A = await api.nextAssignment();
    if (!A) { showDone(); return; }
    W = A.width; H = A.height;
    // everything slow happens before the session starts, so loading time is not counted as clinician time
    eng = await getEngine(A.blind_code, f => $("busytext").textContent = `Loading the model ${Math.round(f * 100)}%`);
    $("busytext").textContent = "Loading the image";
    bitmap = await createImageBitmap(await api.downloadCase(A.image_path));
    const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H;
    const tx = tmp.getContext("2d"); tx.drawImage(bitmap, 0, 0, W, H);
    imgSmall = eng.prepare(tx.getImageData(0, 0, W, H).data, W, H);
    $("busytext").textContent = "Preparing the first outline";
    const prob0 = await eng.initialProb(imgSmall);
    const start = await api.startSession(A.assignment_id);
    sid = start.session_id; steps = [{ prob: prob0 }]; clicks = []; manual = false; manualEdited = false; uploads = []; uploadFailed = false;
    curMaskId = start.initial_mask_id;
    const st = start.state;
    if (start.resumed) {
      $("busytext").textContent = "Restoring your corrections";
      if (st.manual) {
        manual = manualEdited = true; curMaskId = st.mask_id;
        mask = await blobToMask(await api.downloadMask(user.uid, sid, st.mask_id));
      } else {
        for (const c of st.clicks) {
          clicks.push(c);
          steps.push({ prob: await eng.refineStep(imgSmall, steps[steps.length - 1].prob, clicks, W, H) });
        }
        curMaskId = st.mask_id;
        mask = upsampleMask(steps[steps.length - 1].prob, W, H);
        queueUpload(curMaskId, mask, "model");  // in case the earlier upload never finished; duplicates are ignored
      }
    } else {
      mask = upsampleMask(prob0, W, H);
      queueUpload(curMaskId, mask, "initial");
    }
    $("phase").textContent = A.phase === "pilot" ? "Practice case" : "Study case";
    $("manualbox").style.display = manual ? "block" : "none";
    setMask(mask); resetView();
    timerBase = 0; timerStart = Date.now(); lastInput = Date.now(); paused = false; $("paused").style.display = "none"; $("pause").textContent = "Pause";
    if (start.resumed) { await api.logEvent({ session: sid, type: "pause", meta: { reason: "reload" } }); pauseUI(true); }
  } catch (e) {
    console.error(e);
    alert("Could not load the case: " + e.message + "\nReload the page to try again.");
  }
  setBusy(false);
}

function showDone() {
  A = null; sid = null;
  $("app").innerHTML = `<div class="card"><h1>All assigned cases are complete</h1><p>Thank you. There are no more cases to review right now. You will be told when new cases are ready.</p><button id="done-out">Sign out</button></div>`;
  $("done-out").onclick = () => onSignOut();
}
function updateProgress() {
  $("prog").textContent = `${prog.done} of ${prog.total} cases`;
  $("bar").firstElementChild.style.width = (prog.total ? 100 * prog.done / prog.total : 0) + "%";
}

// ---------------------------------------------------------------- drawing and view
function fitCanvas() { cv.width = cv.clientWidth * devicePixelRatio; cv.height = cv.clientHeight * devicePixelRatio; draw(); }
function resetView() {
  fitCanvas();
  const s = Math.min(cv.width / W, cv.height / H) * 0.96;
  view = { s, x: (cv.width - W * s) / 2, y: (cv.height - H * s) / 2 };
  draw();
}
function tinted() {
  if (!tintCv || tintCv.width !== W || tintCv.height !== H) { tintCv = document.createElement("canvas"); tintCv.width = W; tintCv.height = H; }
  const t = tintCv.getContext("2d"); t.globalCompositeOperation = "source-over"; t.clearRect(0, 0, W, H);
  t.drawImage(maskCv, 0, 0); t.globalCompositeOperation = "source-in"; t.fillStyle = "#7a4fd0"; t.fillRect(0, 0, W, H);
  return tintCv;
}
function draw() {
  if (!bitmap || !A) return;
  cx.setTransform(1, 0, 0, 1, 0, 0); cx.fillStyle = "#16141c"; cx.fillRect(0, 0, cv.width, cv.height);
  cx.setTransform(view.s, 0, 0, view.s, view.x, view.y);
  cx.imageSmoothingEnabled = view.s < 3; cx.drawImage(bitmap, 0, 0, W, H);
  if (showOv && maskCv) {
    cx.globalAlpha = 0.22; cx.drawImage(tinted(), 0, 0); cx.globalAlpha = 1;
    if (outlineCv && !stroke) cx.drawImage(outlineCv, 0, 0);
  }
  if (!manual) for (const c of clicks) {
    cx.beginPath(); cx.arc(c.x, c.y, 7 / view.s, 0, 7); cx.fillStyle = c.sign ? "#1b9e4b" : "#d93a3a"; cx.fill();
    cx.lineWidth = 2 / view.s; cx.strokeStyle = "#fff"; cx.stroke();
  }
}
const toImg = e => { const r = cv.getBoundingClientRect(), k = devicePixelRatio; return { x: ((e.clientX - r.left) * k - view.x) / view.s, y: ((e.clientY - r.top) * k - view.y) / view.s }; };

function paintStroke(a, b) {
  const c = maskCv.getContext("2d"), rad = Math.max(1, +$("brush").value / 2 * (W / 512));
  c.globalCompositeOperation = brushMode === "add" ? "source-over" : "destination-out";
  c.fillStyle = c.strokeStyle = "#fff"; c.lineWidth = rad * 2; c.lineCap = "round";
  c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
  c.beginPath(); c.arc(b.x, b.y, rad, 0, 7); c.fill();
  c.globalCompositeOperation = "source-over";
}

// ---------------------------------------------------------------- actions
function refreshButtons() {
  const off = busy || paused || !A;
  for (const id of ["tpos", "tneg", "undo", "reject", "accept", "manual", "flag", "fit", "ov", "mfinish", "badd", "berase", "brush", "help"]) $(id).disabled = off;
  if (!off) { $("undo").disabled = manual || clicks.length === 0; $("tpos").disabled = $("tneg").disabled = manual; $("manual").disabled = manual; $("reject").disabled = manual; }
  $("nclicks").textContent = manual ? "Manual correction in progress" : `${clicks.length} click${clicks.length === 1 ? "" : "s"}`;
  $("tpos").classList.toggle("on", tool === "positive"); $("tneg").classList.toggle("on", tool === "negative");
  $("hint").textContent = manual ? "Draw on the image. Right-drag or Shift+drag to pan, wheel to zoom."
    : "Click the image to place a point. Right-drag or Shift+drag to pan, wheel to zoom. Keys: P +, N −, Z undo, O outline.";
}

async function placeClick(p) {
  if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
  const sign = tool === "positive" ? 1 : 0;
  if (clicks.filter(c => c.sign === sign).length >= 24) { toast("At most 24 clicks of each sign per case. Use manual correction or flag the case."); return; }
  setBusy(true, "Updating the outline");
  try {
    const c = { x: p.x, y: p.y, sign }, next = [...clicks, c], t0 = performance.now();
    const prob = await eng.refineStep(imgSmall, steps[steps.length - 1].prob, next, W, H);
    const m = upsampleMask(prob, W, H), latency = performance.now() - t0, id = newId();
    await api.logEvent({ session: sid, type: "click", sign: tool, x: c.x, y: c.y, before: curMaskId, after: id, latency });
    steps.push({ prob }); clicks = next; curMaskId = id; setMask(m); queueUpload(id, m, "model");
  } catch (e) { toast("Click not saved: " + e.message); }
  setBusy(false);
}
async function undo() {
  if (!clicks.length) return;
  setBusy(true, "Updating the outline");
  try {
    const t0 = performance.now(), prob = steps[steps.length - 2].prob, m = upsampleMask(prob, W, H), latency = performance.now() - t0, id = newId();
    await api.logEvent({ session: sid, type: "undo", before: curMaskId, after: id, latency });
    steps.pop(); clicks.pop(); curMaskId = id; setMask(m); queueUpload(id, m, "model");
  } catch (e) { toast("Undo not saved: " + e.message); }
  setBusy(false);
}
async function sendManual(pts) {
  setBusy(true, "Saving");
  try {
    const m = canvasToMask(maskCv), id = newId();
    await api.logEvent({ session: sid, type: "manual_edit", before: curMaskId, after: id, meta: { tool: brushMode, brush: +$("brush").value, n_points: pts } });
    curMaskId = id; mask = m; manualEdited = true; queueUpload(id, m, "manual"); buildOutline(); draw();
  } catch (e) { toast("Edit not saved: " + e.message); }
  setBusy(false);
}

// ---------------------------------------------------------------- dialogs and decisions
const modal = (html, init) => { $("mbox").innerHTML = html; $("modal").style.display = "flex"; init && init(); };
const closeModal = () => { $("modal").style.display = "none"; };
const scale = n => `<div class="scale" data-name="${n}">${[1, 2, 3, 4, 5].map(i => `<button data-v="${i}">${i}</button>`).join("")}</div>`;
function ratingModal(title, action) {
  const val = {};
  modal(`<h3 style="margin-top:0">${title}</h3><div class="small">Confidence in the final segmentation (1 = low, 5 = high)</div>${scale("conf")}
    <div class="small">Case difficulty (1 = easy, 5 = very difficult)</div>${scale("diff")}
    <div class="row"><button id="mc">Back</button><button class="primary" id="mo" disabled>Confirm</button></div>`, () => {
    document.querySelectorAll("#mbox .scale").forEach(sc => sc.onclick = e => {
      const b = e.target.closest("button"); if (!b) return;
      sc.querySelectorAll("button").forEach(x => x.classList.remove("on")); b.classList.add("on");
      val[sc.dataset.name] = +b.dataset.v; $("mo").disabled = !(val.conf && val.diff);
    });
    $("mc").onclick = closeModal;
    $("mo").onclick = () => { closeModal(); finish(action, { confidence: val.conf, difficulty: val.diff }); };
  });
}
async function finish(action, extra) {
  setBusy(true, "Saving");
  try {
    await flushUploads();
    if (uploadFailed) throw new Error("some masks could not be uploaded. Check your connection and try again.");
    prog = await api.finishSession({ session: sid, action, finalMask: curMaskId, ...extra });
    updateProgress(); sid = null; A = null;
    await nextCase();
  } catch (e) {
    alert("Could not finish this case: " + e.message);
    if (uploadFailed) { // retry the uploads once more
      uploadFailed = false; queueUpload(curMaskId, mask, manualEdited ? "manual" : "model");
    }
    setBusy(false);
  }
}

// ---------------------------------------------------------------- timer, pause, idle
const touch = () => { lastInput = Date.now(); };
function pauseUI(p) {
  paused = p; $("paused").style.display = p ? "flex" : "none"; $("pause").textContent = p ? "Resume" : "Pause";
  if (p) timerBase += Date.now() - timerStart; else timerStart = Date.now();
  refreshButtons();
}
async function doPause(auto) {
  if (paused || !sid || busy) return;
  pauseUI(true);
  try { await api.logEvent({ session: sid, type: "pause", meta: { reason: auto ? "idle" : "user" }, backdate: auto ? CONFIG.IDLE_PAUSE_MS / 1000 : 0 }); } catch (e) { console.error(e); }
}
async function doResume() {
  if (!paused || !sid) return;
  try { await api.logEvent({ session: sid, type: "resume" }); } catch (e) { toast("Could not resume: " + e.message); return; }
  pauseUI(false); touch();
}

// ---------------------------------------------------------------- wiring (once)
let wired = false;
function wireOnce() {
  if (wired) return; wired = true;
  addEventListener("resize", () => { if (A) fitCanvas(); });
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("wheel", e => {
    e.preventDefault(); touch();
    const r = cv.getBoundingClientRect(), k = devicePixelRatio, mx = (e.clientX - r.left) * k, my = (e.clientY - r.top) * k;
    const ns = Math.min(Math.max(view.s * Math.exp(-e.deltaY * 0.0015), 0.2), 40);
    view.x = mx - (mx - view.x) * ns / view.s; view.y = my - (my - view.y) * ns / view.s; view.s = ns; draw();
  }, { passive: false });
  cv.addEventListener("pointerdown", e => {
    touch(); if (busy || paused || !A) return;
    if (e.button === 2 || e.button === 1 || space || e.shiftKey) { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, pan: true }; cv.setPointerCapture(e.pointerId); return; }
    if (e.button !== 0) return;
    const p = toImg(e);
    if (manual) { stroke = { pts: 1, last: p }; paintStroke(p, p); cv.setPointerCapture(e.pointerId); draw(); return; }
    drag = { x: e.clientX, y: e.clientY, click: p };
  });
  cv.addEventListener("pointermove", e => {
    touch();
    if (stroke) { const p = toImg(e); paintStroke(stroke.last, p); stroke.last = p; stroke.pts++; draw(); return; }
    if (drag && drag.pan) { const k = devicePixelRatio; view.x = drag.vx + (e.clientX - drag.x) * k; view.y = drag.vy + (e.clientY - drag.y) * k; draw(); }
  });
  cv.addEventListener("pointerup", async e => {
    if (stroke) { const n = stroke.pts; stroke = null; await sendManual(n); return; }
    const d = drag; drag = null;
    if (!d || d.pan || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    await placeClick(d.click);
  });

  $("tpos").onclick = () => { tool = "positive"; refreshButtons(); };
  $("tneg").onclick = () => { tool = "negative"; refreshButtons(); };
  $("undo").onclick = undo;
  $("reject").onclick = async () => { try { await api.logEvent({ session: sid, type: "reject", before: curMaskId }); toast("Noted. Keep correcting with clicks."); } catch (e) { toast(e.message); } };
  $("ov").onclick = () => { showOv = !showOv; $("ov").classList.toggle("on", showOv); $("ov").textContent = showOv ? "Outline on" : "Outline off"; draw(); };
  $("fit").onclick = resetView;
  $("help").onclick = () => modal(`<div class="doc" style="max-height:60vh;overflow:auto">${helpHtml}</div><div class="row" style="margin-top:12px"><button class="primary" id="mc">Close</button></div>`, () => { $("mc").onclick = closeModal; });
  $("manual").onclick = () => modal(`<h3 style="margin-top:0">Switch to manual correction?</h3><p>You will draw the mask yourself. Clicks are disabled for this case afterward.</p><div class="row"><button id="mc">Cancel</button><button class="primary" id="mo">Start manual correction</button></div>`, () => {
    $("mc").onclick = closeModal;
    $("mo").onclick = () => { closeModal(); manual = true; $("manualbox").style.display = "block"; refreshButtons(); draw(); };
  });
  $("badd").onclick = () => { brushMode = "add"; $("badd").classList.add("on"); $("berase").classList.remove("on"); };
  $("berase").onclick = () => { brushMode = "erase"; $("berase").classList.add("on"); $("badd").classList.remove("on"); };
  $("accept").onclick = () => ratingModal("Accept this mask", "accept");
  $("mfinish").onclick = () => {
    if (!manualEdited) { toast("Draw at least one edit first, or use Accept."); return; }
    ratingModal("Finish manual correction", "manual_complete");
  };
  $("flag").onclick = () => modal(`<h3 style="margin-top:0">Flag this case</h3><p class="small">Use this when the mask cannot be corrected satisfactorily or the image is unclear.</p>
    <select id="fr"><option value="cannot_correct">Cannot be corrected with clicks</option><option value="ambiguous_target">Target is ambiguous</option><option value="poor_image">Poor image quality</option><option value="other">Other</option></select>
    <div class="row" style="margin-top:14px"><button id="mc">Back</button><button class="danger" id="mo">Flag and continue</button></div>`, () => {
    $("mc").onclick = closeModal;
    $("mo").onclick = () => { const n = $("fr").value; closeModal(); finish("flag", { note: n }); };
  });
  $("pause").onclick = () => paused ? doResume() : doPause(false);
  $("resume").onclick = doResume;
  $("signout").onclick = async () => {
    if (sid && !confirm("A case is open. Its timer will pause and you can continue after signing in again. Sign out?")) return;
    if (sid && !paused) await doPause(false);
    onSignOut();
  };

  setInterval(() => {
    if (!A || !sid) return;
    const t = (timerBase + (paused ? 0 : Date.now() - timerStart)) / 1000;
    $("timer").textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    if (!paused && !busy && $("modal").style.display !== "flex" && Date.now() - lastInput > CONFIG.IDLE_PAUSE_MS) doPause(true);
  }, 1000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) doPause(false); });
  addEventListener("beforeunload", e => { if (sid && !window.__leaving) { e.preventDefault(); e.returnValue = ""; } });
  addEventListener("keydown", e => {
    touch();
    if (!A || ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
    if (e.code === "Space") { space = true; e.preventDefault(); return; }
    if ($("modal").style.display === "flex" || busy || paused) return;
    const k = e.key.toLowerCase();
    if (!manual && (k === "p" || k === "+")) { tool = "positive"; refreshButtons(); }
    else if (!manual && (k === "n" || k === "-")) { tool = "negative"; refreshButtons(); }
    else if (k === "z" && !manual && clicks.length) undo();
    else if (k === "o") $("ov").click();
  });
  addEventListener("keyup", e => { if (e.code === "Space") space = false; });
  addEventListener("mousemove", touch);
}

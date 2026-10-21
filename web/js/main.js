// Screens: login -> first-time password -> documents to e-sign -> home -> workflow.
import * as api from "./api.js";
import { CONFIG } from "../config.js";
import { renderMarkdown, normalizeDoc, sha256Hex } from "./md.js";
import { SignaturePad } from "./sign.js";
import { initWork, nextCase } from "./work.js";

const $ = id => document.getElementById(id);
const SCREENS = ["boot", "screen-login", "screen-pw", "screen-sign", "screen-home", "app"];
const show = id => SCREENS.forEach(s => $(s).style.display = s === id ? "block" : "none");
const norm = s => s.toLowerCase().replace(/\s+/g, " ").trim();
let user = null, docs = [], sigs = [], helpHtml = "", pad = null;

document.title = CONFIG.STUDY_NAME;

async function signOut() {
  window.__leaving = true;
  try { await api.logout(); } catch (e) { /* ignore */ }
  location.reload();  // clears every in-memory model, image and mask
}

async function fetchDoc(d) {
  const r = await fetch(`docs/${d.doc_id}_v${d.version}.md?h=${d.body_sha256.slice(0, 12)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`document ${d.doc_id} v${d.version} is missing from the site`);
  const text = normalizeDoc(await r.text());
  if ((await sha256Hex(text)) !== d.body_sha256) {
    throw new Error(`the text of "${d.title}" on this site does not match the registered version. Please contact the study team.`);
  }
  return text;
}

// ---------------------------------------------------------------- login and password
$("lgo").onclick = async () => {
  $("lerr").textContent = "";
  try { user = await api.login($("lid").value, $("lpw").value); await afterLogin(); }
  catch (e) { $("lerr").textContent = /Invalid login/i.test(e.message) ? "Wrong ID or password." : e.message; }
};
$("lpw").onkeydown = e => { if (e.key === "Enter") $("lgo").click(); };

$("pwgo").onclick = async () => {
  const a = $("pw1").value, b = $("pw2").value;
  if (a.length < 10) { $("pwerr").textContent = "Use at least 10 characters."; return; }
  if (a !== b) { $("pwerr").textContent = "The two passwords do not match."; return; }
  try { await api.changePassword(a); user.must_change_password = false; await afterLogin(); }
  catch (e) { $("pwerr").textContent = e.message; }
};

async function afterLogin() {
  if (user.must_change_password) { show("screen-pw"); return; }
  docs = await api.documents(); sigs = await api.mySignatures();
  const unsigned = docs.filter(d => d.required && !sigs.some(s => s.doc_id === d.doc_id && s.version === d.version));
  if (unsigned.length) { await signScreen(unsigned[0], docs.filter(d => d.required).length - unsigned.length + 1, docs.filter(d => d.required).length); return; }
  const ins = docs.find(d => d.doc_id === "instructions");
  try { helpHtml = ins ? renderMarkdown(await fetchDoc(ins)) : ""; } catch (e) { helpHtml = ""; }
  initWork(user, helpHtml, signOut);
  await home();
}

// ---------------------------------------------------------------- e-signature
async function signScreen(d, n, total) {
  show("screen-sign");
  $("signstep").textContent = `Document ${n} of ${total}`;
  $("doctitle").textContent = d.title; $("serr").textContent = "";
  let text;
  try { text = await fetchDoc(d); } catch (e) { $("docbody").innerHTML = `<p class="err">${e.message}</p>`; return; }
  $("docbody").innerHTML = renderMarkdown(text); $("docbody").scrollTop = 0;
  $("snamehint").textContent = `Your registered name is: ${user.display_name}`;
  $("sname").value = ""; $("sread").checked = $("sesign").checked = false;
  if (!pad) { pad = new SignaturePad($("sigpad")); } else { pad.fit(); pad.clear(); }
  const body = $("docbody");
  const atEnd = () => body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
  const check = () => {
    if (atEnd()) { window.__docRead = true; $("scrollhint").style.display = "none"; }
    $("sread").disabled = $("sesign").disabled = !window.__docRead;
    $("ssign").disabled = !(window.__docRead && $("sread").checked && $("sesign").checked && $("sname").value.trim() && !pad.isEmpty());
  };
  window.__docRead = false; $("scrollhint").style.display = "block";
  body.onscroll = check; ["sread", "sesign", "sname"].forEach(i => { $(i).oninput = check; $(i).onchange = check; }); pad.onchange = check;
  $("sclear").onclick = () => pad.clear();
  requestAnimationFrame(check);
  $("ssign").onclick = async () => {
    $("serr").textContent = "";
    if (norm($("sname").value) !== norm(user.display_name)) { $("serr").textContent = `Type your name exactly as registered: ${user.display_name}`; return; }
    $("ssign").disabled = true;
    try {
      await api.signDocument(user.uid, d, d.body_sha256, $("sname").value.trim(), await pad.toBlob());
      await afterLogin();
    } catch (e) { $("serr").textContent = "Could not save your signature: " + e.message; check(); }
  };
}

// ---------------------------------------------------------------- home
async function home() {
  show("screen-home");
  $("hname").textContent = user.display_name;
  $("hmeta").textContent = `Participant ${user.clinician_id}`;
  let p = { done: 0, total: 0 };
  try { p = await api.progress(); } catch (e) { /* shown as zero */ }
  $("hprog").textContent = p.total ? `${p.done} of ${p.total} cases complete.` : "No cases have been released to you yet. You will be told when they are ready.";
  $("hstart").disabled = !p.total || p.done >= p.total;
  $("hstart").textContent = p.done ? "Continue to cases" : "Start";
  $("hstart").onclick = async () => { show("app"); await nextCase(); };
  $("hsigs").innerHTML = "";
  for (const s of sigs.slice().sort((a, b) => a.signed_at.localeCompare(b.signed_at))) {
    const d = docs.find(x => x.doc_id === s.doc_id && x.version === s.version);
    const row = document.createElement("div"); row.className = "sigrow";
    row.innerHTML = `<span>${d ? d.title : s.doc_id}</span><span class="small">${new Date(s.signed_at).toLocaleString()}</span>`;
    const b = document.createElement("button"); b.textContent = "Open record"; b.onclick = () => openRecord(s, d); row.appendChild(b);
    $("hsigs").appendChild(row);
  }
  $("hpw").onclick = () => { user.must_change_password = true; show("screen-pw"); };
  $("hout").onclick = signOut;
}

async function openRecord(s, d) {
  const w = window.open("", "_blank"); if (!w) { alert("Allow pop-ups to open the printable record."); return; }
  const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  try {
    const text = await fetchDoc(d), img = URL.createObjectURL(await api.signatureImage(s.signature_path));
    w.document.write(`<!doctype html><title>Signed record</title><body style="font:15px/1.5 system-ui;max-width:760px;margin:30px auto;padding:0 16px">
      ${renderMarkdown(text)}<hr><h3>Electronic signature record</h3>
      <p>Signed by: <b>${esc(s.typed_name)}</b> (participant ${esc(user.clinician_id)})<br>Signed at: ${esc(new Date(s.signed_at).toString())}<br>
      Document: ${esc(d.title)}, version ${s.version}<br>Document fingerprint (SHA-256): <code>${esc(s.body_sha256)}</code></p>
      <img src="${img}" style="max-width:360px;border:1px solid #ccc"><p><button onclick="print()">Print or save as PDF</button></p>`);
    w.document.close();
  } catch (e) { w.document.write("<p>Could not build the record: " + esc(e.message) + "</p>"); }
}

// ---------------------------------------------------------------- idle sign-out and boot
let lastAct = Date.now();
["pointerdown", "keydown", "wheel"].forEach(ev => addEventListener(ev, () => lastAct = Date.now(), { passive: true }));
setInterval(() => { if (user && Date.now() - lastAct > CONFIG.SIGN_OUT_IDLE_MS) signOut(); }, 30000);

(async function boot() {
  if (CONFIG.SUPABASE_URL.includes("YOUR-PROJECT")) {
    $("boot").innerHTML = "<h1>Site not configured</h1><p>Set SUPABASE_URL and SUPABASE_ANON_KEY in <code>web/config.js</code>.</p>"; return;
  }
  try {
    user = await api.me();
    if (user) await afterLogin(); else show("screen-login");
  } catch (e) { show("screen-login"); }
})();

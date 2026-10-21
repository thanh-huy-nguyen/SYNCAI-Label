import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { CONFIG } from "../config.js";

export const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "syncare-study-auth" },
});

const must = ({ data, error }) => { if (error) { const e = new Error(error.message || String(error)); e.code = error.code; throw e; } return data; };

export const emailFor = id => `${id.trim().toLowerCase()}@${CONFIG.ID_DOMAIN}`;
export async function login(id, password) {
  must(await sb.auth.signInWithPassword({ email: emailFor(id), password }));
  return me();
}
export const logout = () => sb.auth.signOut();
export async function session() { return must(await sb.auth.getSession()).session; }
export async function me() {
  const s = await session(); if (!s) return null;
  const p = must(await sb.from("profiles").select("*").eq("id", s.user.id).single());
  return { ...p, uid: s.user.id };
}
export async function changePassword(pw) {
  must(await sb.auth.updateUser({ password: pw }));
  must(await sb.rpc("rpc_change_password_done"));
}

export async function documents() { return must(await sb.from("documents").select("*").eq("active", true).order("position")); }
export async function mySignatures() { return must(await sb.from("signatures").select("*")); }
export async function signDocument(uid, doc, sha, typedName, pngBlob) {
  const path = `${uid}/${doc.doc_id}_v${doc.version}.png`;
  const up = await sb.storage.from("signatures").upload(path, pngBlob, { contentType: "image/png", upsert: false });
  if (up.error && !/exists|Duplicate/i.test(up.error.message)) throw new Error(up.error.message);
  must(await sb.from("signatures").insert({
    user_id: uid, doc_id: doc.doc_id, version: doc.version, body_sha256: sha, typed_name: typedName,
    signature_path: path, agreed_electronic: true, user_agent: navigator.userAgent.slice(0, 300),
  }));
}
export async function signatureImage(path) { return must(await sb.storage.from("signatures").download(path)); }

export async function progress() { return must(await sb.rpc("rpc_progress")); }
export async function nextAssignment() {
  const rows = must(await sb.from("my_assignments").select("*").in("status", ["pending", "in_progress"])
    .order("batch_index").order("sequence_index").limit(1));
  return rows[0] || null;
}
export const startSession = id => sb.rpc("rpc_start_session", { p_assignment: id }).then(must);
export const logEvent = a => sb.rpc("rpc_log_event", {
  p_session: a.session, p_type: a.type, p_sign: a.sign ?? null, p_x: a.x ?? null, p_y: a.y ?? null,
  p_before: a.before ?? null, p_after: a.after ?? null, p_latency: a.latency ?? null, p_meta: a.meta ?? null,
  p_backdate_s: a.backdate ?? 0,
}).then(must);
export const registerMask = (session, mask, sha, kind) =>
  sb.rpc("rpc_register_mask", { p_session: session, p_mask: mask, p_sha: sha, p_kind: kind }).then(must);
export async function uploadMask(uid, session, maskId, blob) {
  const r = await sb.storage.from("masks").upload(`${uid}/${session}/${maskId}.png`, blob, { contentType: "image/png", upsert: false });
  if (r.error && !/exists|Duplicate/i.test(r.error.message)) throw new Error(r.error.message);
}
export async function downloadMask(uid, session, maskId) { return must(await sb.storage.from("masks").download(`${uid}/${session}/${maskId}.png`)); }
export const finishSession = a => sb.rpc("rpc_finish_session", {
  p_session: a.session, p_action: a.action, p_confidence: a.confidence ?? null, p_difficulty: a.difficulty ?? null,
  p_note: a.note ?? null, p_final_mask: a.finalMask ?? null,
}).then(must);

export async function downloadCase(path) { return must(await sb.storage.from("cases").download(path)); }
export async function downloadModelFile(code, name) { return must(await sb.storage.from("models").download(`${code}/${name}`)); }

export async function sha256Blob(blob) {
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

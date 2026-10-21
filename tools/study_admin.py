"""Study administration against Supabase. Run on your own machine with SUPABASE_URL and SUPABASE_SERVICE_KEY set.

Order of work (see README.md):
  set-documents -> create-user -> import-cases -> export_onnx.py + upload-model -> plan-pilot / plan-stream ->
  release-batch -> (clinicians work) -> export-corrections -> [train M_k] -> upload-model -> register-update ->
  release-batch ... -> randomize-eval -> eval-models -> export_data.py
"""
import argparse
import csv
import hashlib
import json
import random
import secrets
import string
import sys
from pathlib import Path

import cv2
import numpy as np

from sbclient import SB

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "web" / "docs"
MAX_SIDE = 1024
PART = 40 * 1024 * 1024  # stay below the 50 MB per-file limit of the free Supabase plan


def utc():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def sha(b):
    return hashlib.sha256(b).hexdigest()


def normalize_doc(t):
    """Must equal normalizeDoc() in web/js/md.js: LF line endings, no leading or trailing blank lines."""
    return t.replace("\r\n", "\n").strip("\n")


def doc_hash(path):
    return sha(normalize_doc(Path(path).read_text(encoding="utf-8")).encode("utf-8"))


def profile_by_cid(sb, cid):
    r = sb.select("profiles", {"clinician_id": f"eq.{cid}"})
    if not r:
        sys.exit(f"unknown participant {cid}")
    return r[0]


# ---------------------------------------------------------------- documents and users
def cmd_set_documents(a, sb):
    man = json.loads((DOCS / "manifest.json").read_text())
    existing = {(d["doc_id"], d["version"]): d for d in sb.select("documents")}
    signed = {(s["doc_id"], s["version"]) for s in sb.select("signatures")}
    top = {}
    for m in man:
        top[m["doc_id"]] = max(top.get(m["doc_id"], 0), m["version"])
    rows = []
    for m in man:
        f = DOCS / f"{m['doc_id']}_v{m['version']}.md"
        text = normalize_doc(f.read_text(encoding="utf-8"))
        if "[[" in text and not a.allow_placeholders:
            sys.exit(f"{f.name} still has [[placeholders]]. Fill them in (and get IRB-approved wording) before clinicians sign. "
                     "Use --allow-placeholders only for testing.")
        h = sha(text.encode("utf-8"))
        key = (m["doc_id"], m["version"])
        if key in existing and existing[key]["body_sha256"] != h and key in signed:
            sys.exit(f"{f.name} changed after it was signed. Never edit a signed version: copy it to a new version number.")
        rows.append(dict(doc_id=m["doc_id"], version=m["version"], title=m["title"], body_sha256=h,
                         required=m.get("required", True), active=m["version"] == top[m["doc_id"]], position=m.get("position", 0)))
    sb.insert("documents", rows, upsert=True)
    for r in rows:
        print(f"{r['doc_id']} v{r['version']} active={r['active']} sha256={r['body_sha256'][:12]}")


def _pw():
    chars = string.ascii_letters + string.digits
    return "".join(secrets.choice(chars) for _ in range(14))


def cmd_create_user(a, sb):
    pw = a.password or _pw()
    uid = sb.create_user(a.id, pw)
    sb.insert("profiles", [dict(id=uid, clinician_id=a.id, role=a.role, display_name=a.name, must_change_password=True)])
    print(f"created {a.id} ({a.role}), registered name '{a.name}'\ntemporary password (shown once, send it securely): {pw}")


def cmd_reset_password(a, sb):
    p = profile_by_cid(sb, a.id)
    pw = a.password or _pw()
    sb.set_password(p["id"], pw)
    sb.update("profiles", {"id": f"eq.{p['id']}"}, {"must_change_password": True})
    print(f"password reset for {a.id}; temporary password (shown once): {pw}")


# ---------------------------------------------------------------- cases and models
def _resize(img, interp):
    h, w = img.shape[:2]
    s = min(1.0, MAX_SIDE / max(h, w))
    return img if s == 1.0 else cv2.resize(img, (round(w * s), round(h * s)), interpolation=interp)


def cmd_import_cases(a, sb):
    """Manifest CSV columns: case_id, image_path, mask_path, [dataset], [group_id], [stratum | foreground_fraction]."""
    rows = list(csv.DictReader(open(a.manifest)))
    if a.n:
        random.Random(a.seed).shuffle(rows)
        rows = rows[:a.n]
    if "stratum" not in rows[0]:
        if "foreground_fraction" in rows[0]:
            fg = np.array([float(r["foreground_fraction"]) for r in rows])
            q = np.quantile(fg, [1 / 3, 2 / 3])
            for r, f in zip(rows, fg):
                r["stratum"] = "small" if f <= q[0] else "medium" if f <= q[1] else "large"
        else:
            for r in rows:
                r["stratum"] = "na"
    have = {c["case_id"]: c for c in sb.select("cases")}
    group_split = {}
    for c in have.values():
        group_split.setdefault(c["group_id"], set()).add(c["split"])
    added = skipped = 0
    for r in rows:
        cid, gid = r["case_id"], r.get("group_id") or r["case_id"]
        if cid in have or (gid in group_split and group_split[gid] - {a.split}):
            print(f"skip {cid}: already imported or its patient group is in another split")
            skipped += 1
            continue
        img = cv2.imread(r["image_path"], cv2.IMREAD_COLOR)
        if img is None:
            print(f"skip {cid}: unreadable image")
            skipped += 1
            continue
        img = _resize(img, cv2.INTER_AREA)
        token = secrets.token_hex(12)  # opaque storage name: reveals nothing about the label or dataset
        ok, buf = cv2.imencode(".png", img)
        sb.upload("cases", f"img/{token}.png", buf.tobytes(), "image/png")
        ref_path = rid = None
        if r.get("mask_path"):
            m = cv2.imread(r["mask_path"], cv2.IMREAD_GRAYSCALE)
            m = cv2.resize(m, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST)
            ok, mb = cv2.imencode(".png", (m > 127).astype(np.uint8) * 255)
            ref_path = f"ref/{token}.png"
            sb.upload("references", ref_path, mb.tobytes(), "image/png")
        sb.insert("cases", [dict(case_id=cid, dataset=r.get("dataset") or a.dataset, split=a.split, group_id=gid,
                                 stratum=r["stratum"], image_path=f"img/{token}.png", reference_path=ref_path,
                                 width=img.shape[1], height=img.shape[0])])
        if ref_path:
            rid = f"REF_{token}"
            sb.insert("reference_masks", [dict(reference_id=rid, case_id=cid, mask_id=rid, annotation_source=a.reference_source,
                                               annotator_code=a.reference_annotator, adjudication_status="single_annotator",
                                               reference_version="v1", file_sha256=sha(mb.tobytes()), held_out=True)])
        added += 1
    print(f"imported {added} cases into split '{a.split}', skipped {skipped}")


def cmd_upload_model(a, sb):
    d = Path(a.onnx_dir)
    code = "m-" + secrets.token_hex(5)
    man = {}
    for name in ("unet", "refiner"):
        data = (d / f"{name}.onnx").read_bytes()
        parts = []
        for i in range(0, len(data), PART):
            pn = f"{name}.part{i // PART:03d}"
            sb.upload("models", f"{code}/{pn}", data[i:i + PART])
            parts.append(pn)
        man[name] = dict(parts=parts, sha256=sha(data), size=len(data))
    sb.upload("models", f"{code}/manifest.json", json.dumps(man).encode(), "application/json")
    sb.insert("models", [dict(model_id=a.id, blind_code=code, parent_model_id=a.parent, note=a.note,
                              seg_sha256=man["unet"]["sha256"], refiner_sha256=man["refiner"]["sha256"])], upsert=True)
    print(f"model {a.id} uploaded as blinded code {code} ({len(man['unet']['parts'])}+{len(man['refiner']['parts'])} parts)")


# ---------------------------------------------------------------- assignments
def _next_aid(sb):
    rows = sb.select("assignments", {"select": "assignment_id"})
    return max([int(r["assignment_id"][1:]) for r in rows] + [0]) + 1


def _new_assignments(sb, user, cases, phase, batch, models, arms=None, block="", start=0, released=False):
    n = _next_aid(sb)
    out = []
    for i, c in enumerate(cases):
        out.append(dict(assignment_id=f"A{n + i:05d}", case_id=c["case_id"], user_id=user["id"], study_period=phase,
                        randomization_block=block if not arms else f"{block}:{c['stratum']}",
                        randomized_arm=arms[i] if arms else None,
                        actual_model_id=models[i] if isinstance(models, list) else models, sequence_index=start + i,
                        blinded_to_arm=True, used_for_training=False, used_for_primary_analysis=False,
                        phase=phase, batch_index=batch, released=released, status="pending"))
    sb.insert("assignments", out)


def _free_cases(sb, split, user):
    taken = {x["case_id"] for x in sb.select("assignments", {"user_id": f"eq.{user['id']}", "select": "case_id"})}
    return sorted([c for c in sb.select("cases", {"split": f"eq.{split}"}) if c["case_id"] not in taken], key=lambda c: c["case_id"])


def _need_model(sb, mid):
    m = sb.select("models", {"model_id": f"eq.{mid}"})
    if not m:
        sys.exit(f"model {mid} is not uploaded (upload-model first)")
    return m[0]


def cmd_plan_pilot(a, sb):
    _need_model(sb, a.model)
    u = profile_by_cid(sb, a.clinician)
    cs = _free_cases(sb, a.split, u)
    random.Random(a.seed).shuffle(cs)
    cs = cs[:a.n]
    _new_assignments(sb, u, cs, "pilot", 0, a.model, block="pilot", released=True)
    print(f"{len(cs)} pilot cases released to {a.clinician} with model {a.model}")


def cmd_plan_stream(a, sb):
    u = profile_by_cid(sb, a.clinician)
    cs = _free_cases(sb, a.split, u)
    if len(cs) < a.batches * a.per_batch:
        sys.exit(f"need {a.batches * a.per_batch} cases in split '{a.split}', have {len(cs)}")
    random.Random(a.seed).shuffle(cs)
    for b in range(a.batches):
        k = a.first_batch + b
        _new_assignments(sb, u, cs[b * a.per_batch:(b + 1) * a.per_batch], "correction_train", k, None,
                         block=f"batch{k}", start=b * a.per_batch)
    print(f"{a.batches} batches of {a.per_batch} planned for {a.clinician}; none released yet")


def cmd_release_batch(a, sb):
    _need_model(sb, a.model)
    u = profile_by_cid(sb, a.clinician)
    asg = sb.select("assignments", {"user_id": f"eq.{u['id']}", "phase": "in.(correction_train,delineation)"})
    if a.batch > 1 and not a.force:
        open_prev = [x for x in asg if x["batch_index"] == a.batch - 1 and x["status"] != "done"]
        if open_prev:
            sys.exit(f"batch {a.batch - 1} is not finished ({len(open_prev)} open); use --force to override")
    todo = [x for x in asg if x["batch_index"] == a.batch and not x["released"]]
    base = {"user_id": f"eq.{u['id']}", "batch_index": f"eq.{a.batch}", "released": "eq.false"}
    sb.update("assignments", {**base, "phase": "eq.correction_train"}, {"released": True, "actual_model_id": a.model})
    sb.update("assignments", {**base, "phase": "eq.delineation"}, {"released": True})  # drawing cases need no model
    n_d = sum(x["phase"] == "delineation" for x in todo)
    print(f"released {len(todo) - n_d} correction and {n_d} timed drawing cases of batch {a.batch} to {a.clinician} with model {a.model}")


def cmd_plan_delineation(a, sb):
    """Timed from-scratch drawing cases, mixed at random positions into the planned correction batches."""
    u = profile_by_cid(sb, a.clinician)
    cs = _free_cases(sb, a.split, u)
    if len(cs) < a.batches * a.per_batch:
        sys.exit(f"need {a.batches * a.per_batch} cases in split '{a.split}', have {len(cs)}")
    rng = random.Random(a.seed)
    rng.shuffle(cs)
    for b in range(a.batches):
        k = a.first_batch + b
        rows = sb.select("assignments", {"user_id": f"eq.{u['id']}", "batch_index": f"eq.{k}", "phase": "in.(correction_train,delineation)"})
        if any(r["released"] or r["status"] != "pending" for r in rows):
            sys.exit(f"batch {k} is already released or started; plan drawing cases before releasing it")
        _new_assignments(sb, u, cs[b * a.per_batch:(b + 1) * a.per_batch], "delineation", k, None, block=f"batch{k}:delineation", start=1000)
        rows = sb.select("assignments", {"user_id": f"eq.{u['id']}", "batch_index": f"eq.{k}", "phase": "in.(correction_train,delineation)"})
        order = [r["assignment_id"] for r in rows]
        rng.shuffle(order)
        for i, aid in enumerate(order):  # new positions are random across the whole batch
            sb.update("assignments", {"assignment_id": f"eq.{aid}"}, {"sequence_index": i})
        print(f"batch {k}: {len(rows)} cases in random order, {a.per_batch} of them timed drawing")


def cmd_randomize_eval(a, sb):
    _need_model(sb, a.control)
    _need_model(sb, a.treatment)
    u = profile_by_cid(sb, a.clinician)
    cs = _free_cases(sb, a.split, u)
    rng = random.Random(a.seed)
    by = {}
    for c in cs:
        by.setdefault(c["stratum"], []).append(c)
    ordered, arms, left = [], [], []
    for st, g in sorted(by.items()):  # stratified: arms assigned in shuffled pairs within each stratum
        rng.shuffle(g)
        for i in range(0, len(g) - 1, 2):
            pair = ["M0_control", "M5_updated"]
            rng.shuffle(pair)
            ordered += g[i:i + 2]
            arms += pair
        if len(g) % 2:
            left.append(g[-1])
    for i, c in enumerate(left):
        ordered.append(c)
        arms.append(["M0_control", "M5_updated"][(i + rng.randrange(2)) % 2])
    perm = list(range(len(ordered)))
    rng.shuffle(perm)
    ordered, arms = [ordered[i] for i in perm], [arms[i] for i in perm]
    models = [a.control if x == "M0_control" else a.treatment for x in arms]
    _new_assignments(sb, u, ordered, "randomized_eval", 0, models, arms=arms, block=f"seed{a.seed}", released=a.release)
    print(f"randomized {len(ordered)} cases for {a.clinician}: {arms.count('M0_control')} control, "
          f"{arms.count('M5_updated')} updated; released={a.release}")


def cmd_release_eval(a, sb):
    u = profile_by_cid(sb, a.clinician)
    sb.update("assignments", {"user_id": f"eq.{u['id']}", "phase": "eq.randomized_eval"}, {"released": True})
    print(f"released the evaluation cases to {a.clinician}")


# ---------------------------------------------------------------- corrections and updates
def cmd_export_corrections(a, sb):
    u = profile_by_cid(sb, a.clinician)
    out = Path(a.out)
    (out / "masks").mkdir(parents=True, exist_ok=True)
    asg = {x["assignment_id"]: x for x in sb.select("assignments", {"user_id": f"eq.{u['id']}", "phase": "eq.correction_train",
                                                                    "batch_index": f"eq.{a.batch}"})}
    cases = {c["case_id"]: c for c in sb.select("cases")}
    masks = {m["mask_id"]: m for m in sb.select("masks", {"user_id": f"eq.{u['id']}"})}
    ss = [s for s in sb.select("sessions", {"user_id": f"eq.{u['id']}"}) if s["assignment_id"] in asg
          and s["outcome"] in ("accepted", "manual_complete")]
    mid = f"manifest_{a.clinician}_b{a.batch}"
    with open(out / f"{mid}.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["case_id", "image_file", "mask_file", "outcome", "confidence", "session_id", "model_id"])
        for s in ss:
            mrow = masks[s["final_mask_id"]]
            mf = out / "masks" / (s["case_id"].replace("/", "__") + ".png")
            mf.write_bytes(sb.download("masks", mrow["file"]))
            img = out / "masks" / (s["case_id"].replace("/", "__") + "_image.png")
            img.write_bytes(sb.download("cases", cases[s["case_id"]]["image_path"]))
            w.writerow([s["case_id"], img, mf, s["outcome"], s["accept_confidence_1to5"], s["session_id"], s["assigned_model_id"]])
            sb.update("assignments", {"assignment_id": f"eq.{s['assignment_id']}"}, {"used_for_training": True})
    print(f"{len(ss)} accepted corrections written to {out / (mid + '.csv')} (manifest id {mid})")


def cmd_register_update(a, sb):
    new = _need_model(sb, a.new)
    _need_model(sb, a.parent)
    u = profile_by_cid(sb, a.clinician)
    asg = {x["assignment_id"] for x in sb.select("assignments", {"user_id": f"eq.{u['id']}", "phase": "eq.correction_train"})
           if x["batch_index"] <= a.batch}
    ss = [s for s in sb.select("sessions", {"user_id": f"eq.{u['id']}"}) if s["assignment_id"] in asg and s["outcome"]]
    sb.insert("updates", [dict(update_id=f"U_{a.new}", parent_model_id=a.parent, new_model_id=a.new, correction_batch=a.batch,
                               num_sessions=len(ss), num_accepted=sum(s["outcome"] in ("accepted", "manual_complete") for s in ss),
                               num_flagged=sum(s["outcome"] in ("unresolved", "skipped") for s in ss),
                               train_case_manifest_id=a.manifest_id, checkpoint_sha256=new["seg_sha256"],
                               training_code_commit=a.commit, config_id=a.config_id, update_start_utc=a.start,
                               update_finish_utc=a.finish, validation_metric=a.validation_metric, promotion_status=a.status)],
              upsert=True)
    print(f"update {a.parent} -> {a.new} registered ({len(ss)} sessions, status {a.status})")


def cmd_eval_models(a, sb):
    """Dice@0 and boundary metrics of each model's no-click prediction on the held-out cases (needs onnxruntime)."""
    import onnxruntime as ort
    import metrics
    cases = [c for c in sb.select("cases") if c["split"].startswith(a.split) and c["reference_path"]]
    refs = {r["case_id"]: r for r in sb.select("reference_masks")}
    for mid in a.models.split(","):
        m = _need_model(sb, mid)
        man = json.loads(sb.download("models", f"{m['blind_code']}/manifest.json"))
        blob = b"".join(sb.download("models", f"{m['blind_code']}/{p}") for p in man["unet"]["parts"])
        if sha(blob) != man["unet"]["sha256"]:
            sys.exit(f"{mid}: model files failed their hash check")
        sess = ort.InferenceSession(blob, providers=["CPUExecutionProvider"])
        rows = []
        for c in cases:
            img = cv2.imdecode(np.frombuffer(sb.download("cases", c["image_path"]), np.uint8), cv2.IMREAD_COLOR)
            ref = cv2.imdecode(np.frombuffer(sb.download("references", c["reference_path"]), np.uint8), cv2.IMREAD_GRAYSCALE) > 127
            small = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), (256, 256), interpolation=cv2.INTER_LINEAR)
            x = (small.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
            prob = sess.run(None, {"image": x})[0][0, 0]
            pred = (cv2.resize(prob, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_LINEAR) > 0.5).astype(np.uint8)
            ok, pb = cv2.imencode(".png", pred * 255)
            pid = f"EVAL_{mid}_{refs[c['case_id']]['reference_id']}"
            d = metrics.dice(pred, ref)
            rows.append(dict(evaluation_id=f"{mid}_{c['case_id']}", case_id=c["case_id"], split=c["split"], site_id=c["dataset"],
                             model_id=mid, seed="NA", reference_id=refs[c["case_id"]]["reference_id"], predicted_mask_id=pid,
                             dice_0=d, iou_0=metrics.iou(pred, ref), hd95_mm_or_px=_f(metrics.hd95(pred, ref)),
                             assd_mm_or_px=_f(metrics.assd(pred, ref)), fp_components=metrics.fp_components(pred, ref),
                             severe_failure_flag=bool(d < a.severe), evaluated_timestamp_utc=utc(),
                             metric_script_version=metrics.VERSION))
        sb.insert("eval_per_case", rows, upsert=True)
        print(f"{mid}: scored {len(rows)} cases")


def _f(x):
    return None if x != x else x


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest="cmd", required=True)

    def add(name, fn, *args):
        s = sp.add_parser(name)
        for flag, kw in args:
            s.add_argument(flag, **kw)
        s.set_defaults(fn=fn)

    add("set-documents", cmd_set_documents, ("--allow-placeholders", dict(action="store_true")))
    add("create-user", cmd_create_user, ("--id", dict(required=True)), ("--name", dict(required=True, help="full name exactly as the clinician will type it when signing")),
        ("--role", dict(required=True, choices=["corrector", "evaluator", "both"])), ("--password", dict(default=None)))
    add("reset-password", cmd_reset_password, ("--id", dict(required=True)), ("--password", dict(default=None)))
    add("import-cases", cmd_import_cases, ("--manifest", dict(required=True)),
        ("--split", dict(required=True, help="pilot | correction | eval (names starting with 'eval' count as held out)")),
        ("--dataset", dict(default="")), ("--n", dict(type=int, default=0)), ("--seed", dict(type=int, default=0)),
        ("--reference-source", dict(default="dataset_gt")), ("--reference-annotator", dict(default="dataset_annotator")))
    add("upload-model", cmd_upload_model, ("--id", dict(required=True)), ("--onnx-dir", dict(required=True)),
        ("--parent", dict(default=None)), ("--note", dict(default="")))
    add("plan-pilot", cmd_plan_pilot, ("--clinician", dict(required=True)), ("--model", dict(required=True)),
        ("--split", dict(default="pilot")), ("--n", dict(type=int, default=15)), ("--seed", dict(type=int, default=0)))
    add("plan-stream", cmd_plan_stream, ("--clinician", dict(required=True)), ("--split", dict(default="correction")),
        ("--batches", dict(type=int, default=5)), ("--per-batch", dict(type=int, default=20)), ("--seed", dict(type=int, default=0)),
        ("--first-batch", dict(type=int, default=1, help="batch number of the first new batch")))
    add("release-batch", cmd_release_batch, ("--clinician", dict(required=True)), ("--batch", dict(type=int, required=True)),
        ("--model", dict(required=True)), ("--force", dict(action="store_true")))
    add("plan-delineation", cmd_plan_delineation, ("--clinician", dict(required=True)), ("--split", dict(default="delineation")),
        ("--batches", dict(type=int, default=5)), ("--per-batch", dict(type=int, default=4)), ("--seed", dict(type=int, default=0)),
        ("--first-batch", dict(type=int, default=1)))
    add("randomize-eval", cmd_randomize_eval, ("--clinician", dict(required=True)), ("--split", dict(default="eval")),
        ("--control", dict(required=True)), ("--treatment", dict(required=True)), ("--seed", dict(type=int, required=True)),
        ("--release", dict(action="store_true")))
    add("release-eval", cmd_release_eval, ("--clinician", dict(required=True)))
    add("export-corrections", cmd_export_corrections, ("--clinician", dict(required=True)), ("--batch", dict(type=int, required=True)),
        ("--out", dict(required=True)))
    add("register-update", cmd_register_update, ("--clinician", dict(required=True)), ("--parent", dict(required=True)),
        ("--new", dict(required=True)), ("--batch", dict(type=int, required=True)), ("--manifest-id", dict(default=None)),
        ("--commit", dict(default=None)), ("--config-id", dict(default=None)), ("--start", dict(default=None)),
        ("--finish", dict(default=None)), ("--validation-metric", dict(type=float, default=None)),
        ("--status", dict(default="candidate", choices=["candidate", "promoted", "rejected", "rolled_back"])))
    add("eval-models", cmd_eval_models, ("--models", dict(required=True)), ("--split", dict(default="eval")),
        ("--severe", dict(type=float, default=0.5)))
    a = p.parse_args()
    a.fn(a, SB())


if __name__ == "__main__":
    main()

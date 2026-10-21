"""Export the study into the SYNCARE data-capture workbook (same sheets and columns as the template), CSVs, the derived
endpoint tables, and the signature records. Metrics use the held-out references, which only the service key can read.

  python tools/export_data.py --out export/
"""
import argparse
import csv
import statistics as st
from pathlib import Path

import cv2
import numpy as np
import openpyxl

import metrics
from sbclient import SB

TEMPLATE = Path(__file__).resolve().parents[1] / "template" / "SYNCARE_Clinician_Study_Data_Template.xlsx"
BOOL = {"condition_blinded", "manual_edit_used", "blinded_to_arm", "used_for_training", "used_for_primary_analysis",
        "held_out", "severe_failure_flag", "accepted_flag", "failure_flag", "independent_reference_available"}
EXTRA_DICT = [
    ["Events", "event_type", "categorical", "session_start | session_end also appear: they carry the initial and final mask ids", "server"],
    ["Events", "event_timestamp_utc", "timestamp", "Server clock at the moment the action was logged; idle pauses are backdated to the last input", "server"],
    ["Events", "coordinate_system", "text", "image_px_WxH: pixels of the working image shown to the clinician (long side <= 1024)", "server"],
    ["Sessions", "review_seconds", "numeric", "Active time until the first action (click, edit, accept, flag)", "server"],
    ["Sessions", "correction_seconds", "numeric", "Active time leading up to each click, undo or manual edit; model latency excluded", "server"],
    ["Sessions", "verification_seconds", "numeric", "Active time leading up to accept, reject or flag after a model update", "server"],
    ["Sessions", "notes_code", "text", "Coded reason entered with a flag; never free text with patient information", "clinician UI"],
    ["Eval_Per_Case", "severe_failure_flag", "boolean", "Dice@0 below the threshold given to study_admin.py eval-models (default 0.5)", "offline metric script"],
]


class Masks:
    """Downloads each mask once."""

    def __init__(self, sb):
        self.sb, self.cache = sb, {}
        self.rows = {m["mask_id"]: m for m in sb.select("masks")}

    def get(self, mask_id):
        if mask_id not in self.cache:
            r = self.rows.get(mask_id)
            if not r:
                return None
            raw = self.sb.download("masks", r["file"])
            self.cache[mask_id] = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE) > 127
        return self.cache[mask_id]


def _val(k, v):
    if k in BOOL and v is not None:
        return "TRUE" if v else "FALSE"
    return "" if v is None else v


def clinician_metrics(sessions, asg, refs_by_id, ref_masks, masks):
    out = []
    for s in sessions:
        if not s["session_end_utc"]:
            continue
        ref = refs_by_id.get(s["reference_id"])
        pre = post = hd = None
        if ref:
            R = ref_masks(ref["case_id"])
            init, fin = masks.get(s["initial_mask_id"]), masks.get(s["final_mask_id"])
            if init is not None and fin is not None:
                pre, post, hd = metrics.dice(init, R), metrics.dice(fin, R), metrics.hd95(fin, R)
        out.append(dict(
            session_id=s["session_id"], case_id=s["case_id"], clinician_id=s["clinician_id"],
            randomized_arm=asg[s["assignment_id"]]["randomized_arm"], model_id=s["assigned_model_id"],
            active_seconds=s["active_seconds"], num_clicks=s["positive_clicks"] + s["negative_clicks"], final_dice=post,
            final_hd95=None if hd is None or hd != hd else hd, accepted_flag=s["outcome"] == "accepted",
            failure_flag=s["outcome"] in ("unresolved", "skipped"), pre_correction_dice=pre, post_correction_dice=post,
            independent_reference_available=bool(ref and ref["annotator_code"] != s["clinician_id"]),
            phase=s["phase"], outcome=s["outcome"]))
    return out


def click_curve(sessions, events, refs_by_id, ref_masks, masks, kmax=5):
    by = {}
    for e in events:
        by.setdefault(e["session_id"], []).append(e)
    out = []
    for s in sessions:
        ref = refs_by_id.get(s["reference_id"])
        if not s["session_end_utc"] or not ref or s["manual_edit_used"]:
            continue
        R = ref_masks(ref["case_id"])
        stack = [s["initial_mask_id"]]
        for e in sorted(by.get(s["session_id"], []), key=lambda e: e["event_order"]):
            if e["event_type"] == "click":
                stack.append(e["mask_after_id"])
            elif e["event_type"] == "undo" and len(stack) > 1:
                stack.pop()
        d = [metrics.dice(masks.get(stack[min(k, len(stack) - 1)]), R) for k in range(kmax + 1)]
        out.append(dict(session_id=s["session_id"], clinician_id=s["clinician_id"], phase=s["phase"], model_id=s["assigned_model_id"],
                        **{f"dice_{k}": d[k] for k in range(kmax + 1)}, auc_dice_0_3=float(np.mean(d[:4]))))
    return out


def endpoints(cm):
    out = []
    for key in sorted({(r["phase"], r["randomized_arm"] or "", r["model_id"]) for r in cm}):
        g = [r for r in cm if (r["phase"], r["randomized_arm"] or "", r["model_id"]) == key]
        fd = [r["final_dice"] for r in g if r["final_dice"] is not None]
        out.append(dict(phase=key[0], arm=key[1], model_id=key[2], n_sessions=len(g), n_accepted=sum(r["accepted_flag"] for r in g),
                        n_failed=sum(r["failure_flag"] for r in g), median_active_seconds=st.median(r["active_seconds"] for r in g),
                        median_clicks=st.median(r["num_clicks"] for r in g), mean_final_dice=float(np.mean(fd)) if fd else None))
    return out


def write_csv(path, rows, header=None):
    header = header or (list(rows[0]) if rows else [])
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows:
            w.writerow([_val(h, r.get(h)) for h in header])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    (out / "signatures").mkdir(parents=True, exist_ok=True)
    sb = SB()
    t = {n: sb.select(n) for n in ("sessions", "events", "assignments", "reference_masks", "updates", "eval_per_case",
                                   "cases", "profiles", "documents", "signatures")}
    asg = {x["assignment_id"]: x for x in t["assignments"]}
    refs_by_id = {r["reference_id"]: r for r in t["reference_masks"]}
    cases = {c["case_id"]: c for c in t["cases"]}
    masks = Masks(sb)
    ref_cache = {}

    def ref_masks(case_id):
        if case_id not in ref_cache:
            raw = sb.download("references", cases[case_id]["reference_path"])
            ref_cache[case_id] = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE) > 127
        return ref_cache[case_id]

    cm = clinician_metrics(t["sessions"], asg, refs_by_id, ref_masks, masks)
    sheets = {
        "Sessions": sorted(t["sessions"], key=lambda r: r["session_id"]),
        "Events": sorted(t["events"], key=lambda r: (r["session_id"], r["event_order"])),
        "Assignments": sorted(t["assignments"], key=lambda r: r["assignment_id"]),
        "Reference": sorted(t["reference_masks"], key=lambda r: r["reference_id"]),
        "Updates": t["updates"], "Eval_Per_Case": t["eval_per_case"], "Clinician_Metrics": cm,
    }
    # Events carry their metadata as JSON text in the workbook
    import json
    for e in sheets["Events"]:
        e["metadata_json"] = json.dumps(e.get("metadata_json") or {})
    wb = openpyxl.load_workbook(TEMPLATE)
    for name, rows in sheets.items():
        ws = wb[name]
        header = [c.value for c in ws[1]]
        for r in rows:
            ws.append([_val(h, r.get(h)) for h in header])
        write_csv(out / f"{name}.csv", rows, header)
    for r in EXTRA_DICT:
        wb["Data_Dictionary"].append(r)
    wb.save(out / "SYNCARE_Clinician_Study_Data.xlsx")
    write_csv(out / "endpoints_by_arm.csv", endpoints(cm) if cm else [])
    write_csv(out / "click_curve.csv", click_curve(t["sessions"], t["events"], refs_by_id, ref_masks, masks))

    # signature records: who signed which exact text, when, with the signature image
    prof = {p["id"]: p for p in t["profiles"]}
    rows = []
    for s in t["signatures"]:
        p = prof[s["user_id"]]
        img = out / "signatures" / f"{p['clinician_id']}_{s['doc_id']}_v{s['version']}.png"
        img.write_bytes(sb.download("signatures", s["signature_path"]))
        rows.append(dict(clinician_id=p["clinician_id"], registered_name=p["display_name"], typed_name=s["typed_name"],
                         doc_id=s["doc_id"], version=s["version"], body_sha256=s["body_sha256"], signed_at=s["signed_at"],
                         user_agent=s["user_agent"], signature_image=img.name))
    write_csv(out / "signatures.csv", rows, ["clinician_id", "registered_name", "typed_name", "doc_id", "version", "body_sha256",
                                              "signed_at", "user_agent", "signature_image"])
    print(f"exported {len(t['sessions'])} sessions, {len(t['events'])} events, {len(rows)} signatures to {out}")


if __name__ == "__main__":
    main()

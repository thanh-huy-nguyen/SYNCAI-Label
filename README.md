# SYNCARE clinician study site

A website for the cross-clinician correction study: clinicians sign in with an ID and password, e-sign the study
documents, and then correct AI segmentations with clicks. It runs on GitHub Pages with no server of your own.

- **Site** (`web/`): static files on GitHub Pages. The two models (U-Net and RITM refiner) run inside the clinician's browser
  through ONNX Runtime Web, so images and masks never pass through a model server.
- **Backend** (`supabase/schema.sql`): a free Supabase project holds logins, signatures, assignments, event logs and the
  private image and model files. Its row-level security rules, not the site code, decide who can see what.
- **Admin tools** (`tools/`): run on your own machine with the service-role key. They create users, import cases, upload
  models, randomize, release batches, and export the data in the format of
  `template/SYNCARE_Clinician_Study_Data_Template.xlsx`.

## What clinicians see

1. Sign in with the participant ID and the temporary password you sent them, then choose a new password.
2. Read and e-sign four documents in order: informed consent, confidentiality agreement, qualification and conflict of
   interest attestation, and the study instructions. Each needs scrolling to the end, the registered name typed exactly,
   two confirmations, and a drawn signature. The signature, name, server time and a SHA-256 fingerprint of the exact text
   are stored. Nothing else works until every active document is signed; this is enforced in the database, not only in the page.
   If you publish a new version of a document, everyone must sign it before continuing.
3. Work through the assigned cases: practice cases first, then the study cases, in a fixed order. The timer pauses when
   they press Pause, switch tabs, or are idle for 45 s.

Clinicians never see the model id, the arm, the reference masks, or the label hidden in a case name. The browser reads a
blinded view; model files sit under a random code; images have random names.

## One-time setup

1. **Supabase.** Create a free project. In Authentication, turn off "Allow new users to sign up", and set the minimum
   password length to 10. In the SQL editor, paste and run `supabase/schema.sql`.
2. **Site config.** Put the project URL and the anon (public) key in `web/config.js`. Keep `ID_DOMAIN` the same in your shell
   (`export ID_DOMAIN=...`); it only forms the sign-in address `<id>@ID_DOMAIN`, and no email is sent.
3. **GitHub Pages.** Create a repository from this folder, push to `main`, and in Settings > Pages choose "GitHub Actions".
   The workflow in `.github/workflows/pages.yml` publishes `web/`. In Supabase, add the Pages URL under Authentication >
   URL configuration.
4. **Your machine.** In the `syncare` conda env, `pip install requests openpyxl onnxruntime`. Then
   ```bash
   export SUPABASE_URL=https://<ref>.supabase.co
   export SUPABASE_SERVICE_KEY=<service_role key>   # secret: never commit it, never put it in web/
   export ID_DOMAIN=study.example.org
   ```

## Running the study

Replace every `[[placeholder]]` in `web/docs/*.md` with real values and have the IRB approve the wording. The files are
templates, not legal text. `set-documents` refuses to register documents that still contain placeholders.

```bash
cd tools
python study_admin.py set-documents
python study_admin.py create-user --id CLIN_A --name "Full Name" --role corrector     # prints a temporary password once
python study_admin.py create-user --id CLIN_B --name "Full Name" --role evaluator

# cases: one manifest per split; a patient group can never sit in two splits
python study_admin.py import-cases --manifest ../../syncare-cvpr/data/manifests/busi_curated.csv --split pilot --n 15
python study_admin.py import-cases --manifest ... --split correction --n 100
python study_admin.py import-cases --manifest ... --split eval --n 80

# models: export (in the syncare env, checks parity with PyTorch), then upload
python export_onnx.py --seg-ckpt <M0.pt> --refiner-ckpt <refiner.pt> --out build/M0
python study_admin.py upload-model --id M0 --onnx-dir build/M0

python study_admin.py plan-pilot  --clinician CLIN_A --model M0 --n 15
python study_admin.py plan-stream --clinician CLIN_A --batches 5 --per-batch 20
python study_admin.py release-batch --clinician CLIN_A --batch 1 --model M0
```

For each correction batch k: wait until the clinician finishes it, then `export-corrections --batch k`, train M_k on the
labeled data plus all exported corrections, `export_onnx.py`, `upload-model --id M{k} --parent M{k-1}`,
`register-update`, and `release-batch --batch k+1 --model M{k}`. Batch k+1 cannot be released early without `--force`.

After M5 is frozen:

```bash
python study_admin.py randomize-eval --clinician CLIN_B --control M0 --treatment M5 --seed 7 --release
python study_admin.py eval-models --models M0,M5
python export_data.py --out ../export        # workbook, CSVs, endpoints by arm, click curve, signatures with images
```

`reset-password` gives a clinician a new temporary password. Passwords are never stored by this project; Supabase holds salted hashes.

## What was tested, and what was not

- Tested: the full schema, security rules and RPC functions on a real PostgreSQL (two users, unsigned and signed states,
  blinding, ordering, timing, pause handling, undo-aware click counts, cross-user isolation); every admin command and
  the export through the real schema; ONNX output against PyTorch for both models (max difference about 1e-7); the
  browser's image resize and mask upsampling against OpenCV (within one gray level); document hashing in JavaScript
  against Python; syntax of every JavaScript module.
- Not tested: the pages in a browser, and the site against a live Supabase project. Run a full pass yourself with two
  throwaway accounts (sign documents, do five cases, close the tab mid-case and reopen it) before any clinician sees it.
- Speed in the browser is untested. One CPU thread takes about 60 ms per model call natively; the browser runtime is
  slower, so expect a fraction of a second per click, and a first load of about 115 MB of model files per model (cached after).

## Limits to know

- GitHub Pages is public. The site contains no data and no secrets, and the anon key is meant to be public, but all
  protection rests on the database rules in `schema.sql`. Do not loosen them.
- A free Supabase project pauses after a week without activity and has a 1 GB storage cap and a 50 MB per-file limit
  (models are split into 40 MB parts for that reason). Upgrade for a long study.
- E-signatures here are typed name plus drawn signature plus server timestamp plus text fingerprint, recorded under an
  authenticated account. Whether that satisfies your IRB or institution is their call; ask before relying on it.
- Images must be de-identified before import. The site also never asks clinicians for free text.
- The browser tool limits each case to 24 positive and 24 negative clicks (the refiner input is fixed-size).
- A clinician who opens the browser developer tools can see their own network traffic. They cannot read other users' rows,
  references, arms or model ids.

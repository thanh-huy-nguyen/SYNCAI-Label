// Fill these in from Supabase: Project settings > API. The anon key is public by design; the database rules protect the data.
export const CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",
  // Participant IDs are turned into <id>@ID_DOMAIN for Supabase sign-in. No email is ever sent.
  ID_DOMAIN: "study.example.org",
  STUDY_NAME: "SYNCARE Clinician Segmentation Study",
  IDLE_PAUSE_MS: 45000,
  SIGN_OUT_IDLE_MS: 60 * 60 * 1000,
};

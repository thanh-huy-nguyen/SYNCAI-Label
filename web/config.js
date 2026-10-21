// Fill these in from Supabase: Project settings > API. The anon key is public by design; the database rules protect the data.
export const CONFIG = {
  SUPABASE_URL: "https://wzxavnqbuzjxenvwjuua.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6eGF2bnFidXpqeGVudndqdXVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1NzcxMDUsImV4cCI6MjEwODE1MzEwNX0.cgYnv4w_C5NSjNEsWDeAX2pUQ0RIIN8kno68ASBaoW0",
  // Participant IDs are turned into <id>@ID_DOMAIN for Supabase sign-in. No email is ever sent.
  ID_DOMAIN: "study.example.org",
  STUDY_NAME: "SYNCARE Clinician Segmentation Study",
  IDLE_PAUSE_MS: 45000,
  SIGN_OUT_IDLE_MS: 60 * 60 * 1000,
};

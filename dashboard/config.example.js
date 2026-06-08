// Kopieer naar dashboard/config.js en vul je Supabase-project in.
// Deze twee waarden zijn PUBLIEK (anon key) — veilig in een public repo,
// mits RLS aan staat (zie supabase/schema.sql). config.js staat in .gitignore.
window.SMOKE_CONFIG = {
  supabaseUrl: "https://xxxxx.supabase.co",
  supabaseAnonKey: "eyJ...",
};

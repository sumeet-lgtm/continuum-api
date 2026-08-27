import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://ghdkanhhfhxfbskszuqk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZGthbmhoZmh4ZmJza3N6dXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwODQ1OTEsImV4cCI6MjA5MjY2MDU5MX0.Kl1x4E7gjI7XV2ddgYen1cfkg2RWhVN_8SAuK874YRM";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  },
});

export const API_BASE = "https://api.continuumapi.com";

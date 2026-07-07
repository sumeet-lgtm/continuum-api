-- Signup automation: auth.users INSERT -> profile + free-plan API key.
-- Applied to prod (ghdkanhhfhxfbskszuqk) on 2026-07-07.
--
-- The trigger `on_auth_user_created` on auth.users calls this function.
-- SET search_path is REQUIRED: pgcrypto lives in the `extensions` schema on
-- Supabase, and the auth admin role's search_path does not include it — the
-- original version of this function failed silently on every signup because
-- digest()/gen_random_bytes() could not be resolved (the EXCEPTION handler
-- swallowed the error by design so signups never break).
--
-- NOTE: the hash salt below must equal API_KEY_SALT on the API services.

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
DECLARE
  v_raw_key TEXT;
  v_key_id  TEXT;
  v_prefix  TEXT;
BEGIN
  v_raw_key := 'cnt_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_key_id  := encode(extensions.gen_random_bytes(8), 'hex');
  v_prefix  := substring(v_raw_key, 1, 12);

  INSERT INTO public.api_keys (
    id, "keyHash", "keyPrefix", "keyRaw", "userId", "ownerId",
    label, plan, "monthlyLimit", "currentMonthUsage", "usageResetAt",
    "rateLimit", "isActive", "createdAt"
  ) VALUES (
    v_key_id,
    encode(extensions.digest('7f3a9b2c1d8e4f6a0b5c7d9e2f4a8b1c3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f' || v_raw_key, 'sha256'), 'hex'),
    v_prefix,
    v_raw_key,
    NEW.id::text,
    NEW.email,
    'Default',
    'free',
    1000,
    0,
    date_trunc('month', now()) + interval '1 month',
    1000,
    true,
    now()
  ) ON CONFLICT DO NOTHING;

  INSERT INTO public.profiles (
    id, "userId", email, "fullName", plan, "createdAt"
  ) VALUES (
    'prof-' || v_key_id,
    NEW.id::text,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'free',
    now()
  ) ON CONFLICT ("userId") DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never fail the signup even if key creation fails
  RAISE WARNING 'handle_new_user failed: %', SQLERRM;
  RETURN NEW;
END;
$function$;

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Service-role client — full DB access, bypasses RLS
// NEVER expose this key to the client side
let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }
  return _supabase;
}

export const supabase = getSupabase();

/**
 * Upload a buffer to Supabase Storage.
 * Returns the storage path on success.
 */
export async function uploadToStorage(
  bucket: string,
  path: string,
  data: Buffer | Uint8Array,
  contentType: string,
): Promise<string> {
  const { error } = await supabase.storage.from(bucket).upload(path, data, {
    contentType,
    upsert: false,
  });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return path;
}

/**
 * Download a file from Supabase Storage as a Buffer.
 */
export async function downloadFromStorage(bucket: string, path: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(bucket).download(path);

  if (error || !data) {
    throw new Error(`Storage download failed: ${error?.message ?? 'No data returned'}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Generate a signed URL valid for the given number of seconds.
 */
export async function createSignedUrl(
  bucket: string,
  path: string,
  expiresInSeconds: number,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to create signed URL: ${error?.message ?? 'No URL returned'}`);
  }

  return data.signedUrl;
}

/**
 * Delete a file from Supabase Storage.
 */
export async function deleteFromStorage(bucket: string, path: string): Promise<void> {
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) {
    throw new Error(`Storage delete failed: ${error.message}`);
  }
}

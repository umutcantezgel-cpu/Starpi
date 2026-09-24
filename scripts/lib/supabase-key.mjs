// The only Supabase key that may ship to browsers is the public one: a publishable key
// (sb_publishable_…, projects since 2025) or a legacy JWT whose role is "anon". Secret keys
// (sb_secret_…) and service_role JWTs bypass row level security and are refused.

/**
 * @param {string} key
 * @returns {'publishable' | 'anon-jwt'}
 */
export function assertPublicKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('STARPI_SUPABASE_ANON_KEY is empty');
  if (key.startsWith('sb_secret_')) throw new Error('STARPI_SUPABASE_ANON_KEY is a secret key (sb_secret_…); use the publishable key');
  if (key.startsWith('sb_publishable_')) return 'publishable';
  const [, payload] = key.split('.');
  let role;
  try {
    role = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')).role;
  } catch {
    throw new Error('STARPI_SUPABASE_ANON_KEY is neither a publishable key (sb_publishable_…) nor a valid JWT');
  }
  if (role !== 'anon') throw new Error(`STARPI_SUPABASE_ANON_KEY must have role "anon", got "${role}"`);
  return 'anon-jwt';
}

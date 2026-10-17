// @ts-check
// The Supabase library as a lazy entry of the build: supabase.js imports this module by its URL when
// it first needs a client, so the library is not part of the first load (scripts/build.mjs).
export { createClient } from '@supabase/supabase-js';

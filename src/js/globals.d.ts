// Build-time constants injected by esbuild `define` (see scripts/build.mjs).
declare const __STARPI_SUPABASE_URL__: string;
declare const __STARPI_SUPABASE_ANON_KEY__: string;
declare const __STARPI_VERSION__: string;
// The header profile the build was made for ("companion": served by the local companion).
declare const __STARPI_PROFILE__: string;

// The pdf.js worker module registers globalThis.pdfjsWorker when imported; it has no types.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';

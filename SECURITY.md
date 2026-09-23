# Security Policy

## Supported versions

Security fixes are made on the `main` branch, which is what https://www.starpi.app deploys.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → Advisories → Report a vulnerability** in this repository. Do not open a public
issue for security problems.

Include the affected component (frontend, service worker, database policies, Python backend,
deployment scripts), reproduction steps, and the impact you observed. You can expect an initial
response within 7 days. Coordinated disclosure timelines are agreed per report.

## Scope

In scope:

- Cross-site scripting, HTML or Markdown injection, CSP bypasses in the web application
- Row Level Security or privilege problems in `backend/supabase` (reading or modifying another
  user's chats or private knowledge entries, bypassing `is_public`, calling privileged functions)
- Credential exposure (provider API keys, Supabase `service_role` key)
- Authentication, CORS or request-handling flaws in `backend/server.py`
- Service worker behaviour that caches private data or serves stale code

Out of scope:

- The Supabase **anon** key embedded in the frontend. It is public by design; access is
  enforced by RLS.
- Denial of service through large model downloads a user explicitly confirms
- Vulnerabilities in third-party providers (Supabase, Google Gemini, OpenRouter, Hugging Face)

## Security model in brief

- Browsers use the anon key plus an anonymous Supabase session. RLS limits chat history to its
  owner and private knowledge rows to their creator; browser roles cannot execute SECURITY
  DEFINER functions.
- The frontend ships with a strict Content-Security-Policy (no inline scripts, handlers or
  styles; no remote images) and sanitizes all rendered Markdown.
- The Python backend holds the `service_role` key, binds to `127.0.0.1` by default and requires
  a bearer token when exposed on another interface.
- CI runs gitleaks on the working tree and on the commits of every pull request.

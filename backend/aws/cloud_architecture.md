# Running the backend on AWS EC2

The Starpi PWA runs in the browser and talks to Supabase directly with the anon key; anonymous
sign-ins plus owner-based row level security keep each user's rows private. The Python backend in
`backend/` is optional. It ingests documents and answers retrieval queries with the Supabase
**service role key**, which bypasses RLS, so it must only run on a machine you control.

## Architecture

```
API client ──HTTPS──> Caddy / nginx (TLS, port 443) on EC2
                           │
                           ▼
                 127.0.0.1:9200  server.py  (starpi-brain.service)
                   - Bearer token on /api/brain/*
                   - CORS allow-list (BRAIN_ALLOWED_ORIGINS)
                           │
          ┌────────────────┼──────────────────────┐
          ▼                ▼                      ▼
   Supabase REST     Chat model endpoint    Embedding endpoint
   (service role)    (vLLM, hosted pools)   (1536 dimensions)
```

`BRAIN_API_TOKEN` is a server credential. Do not embed it in the PWA or any other code shipped to
browsers.

## Network

| Port | Exposure |
| --- | --- |
| 22 | SSH, restricted to your own IP in the security group |
| 80, 443 | Reverse proxy (80 only for the ACME certificate challenge) |
| 9200 | Loopback only. Never open it in the security group |

There is no separate web UI port; the PWA is hosted elsewhere.

## Deployment

1. Launch an Ubuntu 22.04 or 24.04 instance. A small instance (e.g. `t3.small`) is enough for the
   API; model inference needs a GPU instance or a hosted endpoint.
2. From your machine run `backend/remote_sync.sh <host> <key.pem>`. It copies `backend/` (never the
   local `.env`) to `~/starpi-brain` and runs `aws/deploy_ec2.sh`, which creates a virtualenv,
   installs `requirements.txt` and installs `starpi-brain.service` bound to `127.0.0.1`.
3. On the server, fill in `~/starpi-brain/.env` (mode 600), including `BRAIN_API_TOKEN`
   (`openssl rand -hex 32`), then `sudo systemctl restart starpi-brain`.
4. Install Caddy (or nginx) and proxy your domain to the API, for example
   `api.example.com { reverse_proxy 127.0.0.1:9200 }`.
5. Check: `curl https://api.example.com/api/health` and
   `curl -H "Authorization: Bearer $TOKEN" https://api.example.com/api/brain/documents`.

## Operations

- Logs: `journalctl -u starpi-brain -f`
- Updates: rerun `remote_sync.sh`; the deploy script restarts the service.
- Costs: set an AWS Budgets alert on the account.
- Secrets: if the service role key or API token leaks, rotate it in Supabase / the `.env` and
  restart the service.

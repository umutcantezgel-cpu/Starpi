#!/usr/bin/env bash
# ==============================================================================
# Installs the brain API as a systemd service on an Ubuntu 22.04 / 24.04 host.
#
# Run on the server from the synced backend directory (remote_sync.sh does this):
#   bash aws/deploy_ec2.sh
#
# Result:
#   - virtualenv in <backend>/.venv with requirements.txt installed
#   - <backend>/.env (created from .env.example on first run, mode 600)
#   - BRAIN_API_TOKEN in that .env, generated with openssl when it is missing or
#     empty (never printed)
#   - starpi-brain.service running server.py as $SERVICE_USER (default: ubuntu),
#     bound to 127.0.0.1 only. The service reads that .env itself (core/config.py),
#     so local runs and the service parse it the same way; the file belongs to
#     $SERVICE_USER.
#   - a health check of /api/health; the script fails when the service does not
#     answer within 20 seconds
#
# Nothing is exposed publicly. A TLS reverse proxy (Caddy or nginx) on this host
# makes every request arrive from 127.0.0.1, so the API must never run without
# a token once one is in front; this script makes sure a token exists.
# ==============================================================================

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="starpi-brain"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
VENV_DIR="${APP_DIR}/.venv"
ENV_FILE="${APP_DIR}/.env"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "${SERVICE_USER}" == "root" ]]; then
    echo "Refusing to run the service as root; set SERVICE_USER to an unprivileged user." >&2
    exit 1
fi
if ! id -u "${SERVICE_USER}" > /dev/null 2>&1; then
    echo "User '${SERVICE_USER}' does not exist; set SERVICE_USER." >&2
    exit 1
fi

# Runs a command as the service user (directly when that is the current user).
as_service_user() {
    if [[ "$(id -un)" == "${SERVICE_USER}" ]]; then
        "$@"
    else
        sudo -u "${SERVICE_USER}" "$@"
    fi
}

# Prints the .env, also when it already belongs to another service user (mode 600).
read_env_file() {
    if [[ -r "${ENV_FILE}" ]]; then
        cat "${ENV_FILE}"
    else
        sudo cat "${ENV_FILE}"
    fi
}

echo "[1/5] Installing system packages"
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv curl openssl

echo "[2/5] Creating virtualenv in ${VENV_DIR}"
python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip
"${VENV_DIR}/bin/python" -m pip install -r "${APP_DIR}/requirements.txt"

echo "[3/5] Preparing ${ENV_FILE}"
# Files created in this step (the .env, its temporary copy) are private to the owner.
saved_umask="$(umask)"
umask 077
if [[ ! -f "${ENV_FILE}" ]]; then
    cp "${APP_DIR}/.env.example" "${ENV_FILE}"
    echo "      Created from .env.example. Fill in the values, then restart the service."
fi
# The token step below rewrites the file from what it reads; never let a failed read empty it.
if ! read_env_file > /dev/null; then
    echo "Cannot read ${ENV_FILE}; aborting without changes." >&2
    exit 1
fi
# After the first run the file belongs to the service user, which may not be the current user.
if [[ -O "${ENV_FILE}" ]]; then
    chmod 600 "${ENV_FILE}"
else
    sudo chmod 600 "${ENV_FILE}"
fi

TOKEN_LINE_RE='^[[:space:]]*(export[[:space:]]+)?BRAIN_API_TOKEN[[:space:]]*='

# True when the last BRAIN_API_TOKEN assignment has a value (quotes, blanks and an inline
# comment removed).
env_token_is_set() {
    local line value=""
    while IFS= read -r line || [[ -n "${line}" ]]; do
        if [[ "${line}" =~ ${TOKEN_LINE_RE} ]]; then
            value="${line#*=}"
            value="${value%%[[:space:]]#*}"
            value="${value//[\"\' $'\t\r']/}"
        fi
    done < <(read_env_file)
    [[ -n "${value}" ]]
}

# A reverse proxy on this host makes every request look like loopback; without a token the API
# would serve everyone who reaches the proxy. Generate one when it is missing. The value goes from
# openssl into the file through bash builtins only: it is never echoed, logged or put on a
# command line.
if ! env_token_is_set; then
    tmp_env="$(mktemp "${ENV_FILE}.XXXXXX")"
    trap 'rm -f "${tmp_env:-}"' EXIT
    api_token="$(openssl rand -hex 32)"
    if [[ ! "${api_token}" =~ ^[0-9a-f]{64}$ ]]; then
        echo "openssl rand did not return a 64 character hex token; aborting." >&2
        exit 1
    fi
    {
        replaced=0
        while IFS= read -r line || [[ -n "${line}" ]]; do
            if [[ "${line}" =~ ${TOKEN_LINE_RE} ]]; then
                # Replace the first assignment in place, drop any later ones.
                (( replaced )) || printf 'BRAIN_API_TOKEN=%s\n' "${api_token}"
                replaced=1
                continue
            fi
            printf '%s\n' "${line}"
        done < <(read_env_file)
        (( replaced )) || printf 'BRAIN_API_TOKEN=%s\n' "${api_token}"
    } > "${tmp_env}"
    unset api_token line replaced
    chmod 600 "${tmp_env}"
    mv -f "${tmp_env}" "${ENV_FILE}"
    trap - EXIT
    echo "      Generated BRAIN_API_TOKEN in ${ENV_FILE} (not shown). Clients send it as"
    echo "      'Authorization: Bearer <token>'; read it from that file on this host."
fi
# The service reads the .env itself, so the (private) file must belong to the service user.
if [[ "$(stat -c %U "${ENV_FILE}")" != "${SERVICE_USER}" ]]; then
    sudo chown "${SERVICE_USER}" "${ENV_FILE}"
fi
umask "${saved_umask}"

echo "[4/5] Writing ${UNIT_FILE}"
sudo tee "${UNIT_FILE}" > /dev/null <<EOF
[Unit]
Description=Starpi brain API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
# No EnvironmentFile: server.py loads ${ENV_FILE} itself, so inline comments and quotes are
# parsed the same way as in local runs (systemd would keep "# comment" as part of a value).
# Always loopback; a reverse proxy on this host terminates TLS.
ExecStart=${VENV_DIR}/bin/python ${APP_DIR}/server.py --host 127.0.0.1
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

echo "[5/5] Starting ${SERVICE_NAME}"
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}.service"
sudo systemctl restart "${SERVICE_NAME}.service"

# The port as the service sees it: the same config loader, the same .env.
PORT="$(cd "${APP_DIR}" && as_service_user "${VENV_DIR}/bin/python" -c 'from core.config import config; print(config.server_port)')"
healthy=0
for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" > /dev/null 2>&1; then
        healthy=1
        break
    fi
    sleep 1
done
sudo systemctl --no-pager --lines=5 status "${SERVICE_NAME}.service" || true
if (( ! healthy )); then
    echo "Health check failed: nothing answered on http://127.0.0.1:${PORT}/api/health within 20 s." >&2
    echo "Inspect the service log: journalctl -u ${SERVICE_NAME} -n 50 --no-pager" >&2
    exit 1
fi
echo "Health check OK on 127.0.0.1:${PORT}"

cat <<EOF

Next steps
  1. Edit ${ENV_FILE} as ${SERVICE_USER} (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
     model endpoints), then run: sudo systemctl restart ${SERVICE_NAME}
  2. The API listens on 127.0.0.1:${PORT} only. Do not open that port in the
     security group. To serve it to browsers, put a TLS reverse proxy in front,
     for example Caddy:  your.domain { reverse_proxy 127.0.0.1:${PORT} }
  3. /api/brain/* requires the BRAIN_API_TOKEN from ${ENV_FILE} as a Bearer
     token (keep it server side). Add the site's origin to
     BRAIN_ALLOWED_ORIGINS there before exposing the API.
  Logs: journalctl -u ${SERVICE_NAME} -f
EOF

#!/usr/bin/env bash
# ==============================================================================
# Copies this backend directory to an Ubuntu server over SSH and runs
# aws/deploy_ec2.sh there.
#
# Usage: ./remote_sync.sh <HOST> <PATH_TO_SSH_KEY> [REMOTE_USER]
#   REMOTE_USER defaults to "ubuntu".
#   REMOTE_DIR (env) defaults to "starpi-brain", relative to the remote home.
#
# Local .env files are never copied. Secrets live only in <REMOTE_DIR>/.env on
# the server.
# ==============================================================================

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <HOST> <PATH_TO_SSH_KEY> [REMOTE_USER]" >&2
    echo "Example: $0 203.0.113.10 ~/.ssh/starpi-brain.pem" >&2
    exit 1
fi

HOST="$1"
KEY_PATH="$2"
REMOTE_USER="${3:-ubuntu}"
REMOTE_DIR="${REMOTE_DIR:-starpi-brain}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${REMOTE_USER}@${HOST}"

if [[ ! -r "${KEY_PATH}" ]]; then
    echo "SSH key not readable: ${KEY_PATH}" >&2
    exit 1
fi
if [[ "${KEY_PATH}" == *"'"* ]]; then
    echo "SSH key path must not contain a single quote: ${KEY_PATH}" >&2
    exit 1
fi

# ssh rejects private keys that group or others can read. Warn; never change the user's file.
KEY_MODE="$(stat -c '%a' "${KEY_PATH}" 2> /dev/null || stat -f '%Lp' "${KEY_PATH}" 2> /dev/null || true)"
if [[ "${KEY_MODE}" =~ ^[0-7]+$ ]] && (( 8#${KEY_MODE} & 8#077 )); then
    echo "Warning: ${KEY_PATH} has mode ${KEY_MODE}; ssh may refuse it. Fix with: chmod 600 '${KEY_PATH}'" >&2
fi

SSH_OPTS=(-i "${KEY_PATH}" -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes)
# rsync splits -e on spaces and honours single quotes.
RSYNC_RSH="ssh -i '${KEY_PATH}' -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes"

printf -v REMOTE_DIR_Q '%q' "${REMOTE_DIR}"

echo "[1/2] Syncing ${SOURCE_DIR}/ to ${TARGET}:${REMOTE_DIR}/"
ssh "${SSH_OPTS[@]}" "${TARGET}" "mkdir -p -- ${REMOTE_DIR_Q}"
rsync -az \
    -e "${RSYNC_RSH}" \
    --exclude '.env' \
    --exclude '.env.local' \
    --exclude '.venv' \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    --exclude '*.log' \
    --exclude '.ruff_cache' \
    "${SOURCE_DIR}/" "${TARGET}:${REMOTE_DIR}/"

echo "[2/2] Running deploy script on ${TARGET}"
ssh "${SSH_OPTS[@]}" "${TARGET}" "bash ${REMOTE_DIR_Q}/aws/deploy_ec2.sh"

cat <<EOF

Done. The API listens on 127.0.0.1 on the server and is not publicly reachable.
  Health check: ssh -i '${KEY_PATH}' ${TARGET} curl -s http://127.0.0.1:9200/api/health
  SSH tunnel:   ssh -i '${KEY_PATH}' -L 9200:127.0.0.1:9200 ${TARGET}
EOF

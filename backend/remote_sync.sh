#!/usr/bin/env bash
# ==============================================================================
# Enterprise Brain: One-Command AWS Sync & Remote Launcher
# Usage: ./remote_sync.sh <EC2_PUBLIC_IP> <PATH_TO_PEM_KEY>
# ==============================================================================

set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "❌ Benutzung: ./remote_sync.sh <EC2_PUBLIC_IP> <PATH_TO_PEM_KEY>"
    echo "Beispiel: ./remote_sync.sh 54.210.12.34 ~/Downloads/enterprise-brain-key.pem"
    exit 1
fi

EC2_IP="$1"
KEY_PATH="$2"

echo "=================================================="
echo "   🚀 Synchronisiere Enterprise Brain zu AWS      "
echo "   🌐 Ziel-Server: $EC2_IP                        "
echo "=================================================="

# 1. SSH Key Berechtigungen absichern
chmod 400 "$KEY_PATH"

# 2. Dateien auf den AWS Server übertragen
echo "[1/3] Übertrage Enterprise-Brain Dateien auf EC2..."
ssh -o StrictHostKeyChecking=no -i "$KEY_PATH" ubuntu@"$EC2_IP" "mkdir -p ~/enterprise-brain"
rsync -avz -e "ssh -o StrictHostKeyChecking=no -i $KEY_PATH" \
    --exclude '.venv' \
    --exclude '__pycache__' \
    --exclude '*.log' \
    /Users/umurey/LocalModels/enterprise-brain/ ubuntu@"$EC2_IP":~/enterprise-brain/

# 3. Remote Setup & Serverstart ausführen
echo "[2/3] Führe Remote-Setup auf AWS aus..."
ssh -o StrictHostKeyChecking=no -i "$KEY_PATH" ubuntu@"$EC2_IP" "bash ~/enterprise-brain/aws/deploy_ec2.sh"

# 4. Fertigmeldung
echo "[3/3] ✅ Erfolgreich bereitgestellt!"
echo "=================================================="
echo "🎉 Ihr Enterprise Brain läuft jetzt auf AWS!"
echo "📱 Öffnen Sie im Browser auf Smartphone & Desktop:"
echo "👉 Web-Interface: http://$EC2_IP:9119"
echo "👉 Brain API:      http://$EC2_IP:9200/api/health"
echo "=================================================="

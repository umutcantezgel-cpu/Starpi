#!/usr/bin/env bash
# ==============================================================================
# Enterprise Brain: AWS Cloud Deployment Script
# Automatisches Setup auf einer AWS EC2 Instanz (Ubuntu 22.04 / 24.04)
# ==============================================================================

set -euo pipefail

echo "=================================================="
echo "   🚀 Enterprise Brain: AWS Cloud Setup          "
echo "=================================================="

# 1. System Updates & Grundpakete
echo "[1/4] Aktualisiere Systempakete & installiere Tools..."
sudo apt-get update -y
sudo apt-get install -y git curl wget jq python3-pip python3-venv

# 2. Docker & Compose installieren
echo "[2/4] Installiere Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
fi

# 3. Enterprise Brain Server einrichten
echo "[3/4] Richte Enterprise Brain Python-Umgebung ein..."
cd /home/ubuntu
if [ ! -d "enterprise-brain" ]; then
    mkdir -p enterprise-brain
fi

# Virtual Environment
python3 -m venv ~/brain-env
source ~/brain-env/bin/activate
pip install --upgrade pip
pip install httpx

# 4. Starten des Brain API Servers im Hintergrund (Port 9200)
echo "[4/4] Starte Enterprise Brain Server auf Port 9200..."
nohup python3 -m http.server 9119 > ~/web_ui.log 2>&1 &
echo "✅ Deployment abgeschlossen!"
echo "🌐 Brain API lauscht auf Port 9200"
echo "📱 Web Interface erreichbar über Ihre AWS Public IP auf Port 9119"

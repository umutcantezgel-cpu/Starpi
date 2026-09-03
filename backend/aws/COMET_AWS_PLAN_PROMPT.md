# 🤖 Master Plan-Prompt für den Perplexity Comet Assistenten
## Ziel: Automatische AWS-Konfiguration im Browser für das Enterprise Brain & Cloud LLM

> **Anleitung:** Kopieren Sie den gesamten Text im folgenden Block und fügen Sie ihn direkt in Ihren **Perplexity Comet Browser-Assistenten** ein, während Sie in der AWS-Konsole angemeldet sind.

---

```markdown
Du bist mein autonomer Cloud-Infrastruktur- und DevOps-Assistent. Du hast direkten Zugriff auf meine aktive AWS-Konsole (Konto: codayweb / 612062119412, Region: us-east-1 / Nord-Virginia).

Deine Mission:
Konfiguriere im Browser alle notwendigen AWS-Ressourcen für unser privates "Enterprise Brain" (Web-Dashboard, Ingestion-API & Cloud-LLM-Inferenz) gemäß den folgenden 4 Phasen. Führe die Schritte präzise aus, nutze das vorhandene 100 $ Startguthaben und gib mir am Ende alle Verbindungsdaten in einer sauberen Übersicht zurück.

---

### PHASE 1: Kosten-Schutz & 20 $ Bonus-Guthaben freischalten (AWS Budgets)
1. Navigiere in der Konsole zu "AWS Budgets" (oder suche oben in der Suchleiste nach "Budgets").
2. Klicke auf "Create budget" (Budget erstellen).
3. Wähle die Vorlage "Monthly cost budget" (Monatliches Kostenbudget).
4. Setze den Betrag auf genau "20.00 USD".
5. Konfiguriere einen Alarm bei 80 % (16,00 $) und 100 % (20,00 $) mit meiner im AWS-Konto hinterlegten E-Mail-Adresse.
6. Erstelle das Budget.
*(Dies schaltet automatisch die ersten 20 $ zusätzliches Gratis-Guthaben unter "AWS erkunden" frei und stellt sicher, dass niemals unerwartete Kosten entstehen!)*

---

### PHASE 2: Sicherheitsgruppe konfigurieren (Security Group)
1. Navigiere zu "EC2" -> "Security Groups" (Sicherheitsgruppen).
2. Klicke auf "Create security group".
3. Name: `enterprise-brain-sg`
4. Beschreibung: `Security group for Enterprise Brain Web UI, API, and LLM Inference`
5. VPC: Standard-VPC belassen.
6. Füge folgende Inbound Rules (Eingehende Regeln) hinzu:
   - Type: SSH | Port: 22 | Source: My IP (oder 0.0.0.0/0)
   - Type: Custom TCP | Port: 9119 | Source: 0.0.0.0/0 | Beschreibung: "Hermes Web UI"
   - Type: Custom TCP | Port: 9200 | Source: 0.0.0.0/0 | Beschreibung: "Enterprise Brain REST API"
   - Type: Custom TCP | Port: 8000 | Source: 0.0.0.0/0 | Beschreibung: "LLM Inference Engine"
   - Type: HTTP | Port: 80 | Source: 0.0.0.0/0
   - Type: HTTPS | Port: 443 | Source: 0.0.0.0/0
7. Speichere die Sicherheitsgruppe ab.

---

### PHASE 3: EC2 Cloud-Server starten (Launch Instance)
1. Navigiere zu "EC2" -> "Instances" -> klicke auf "Launch instances" (Instanz starten).
2. Name: `enterprise-brain-server`
3. Betriebssystem (AMI): Wähle `Ubuntu Server 24.04 LTS (HVM), SSD Volume Type` (64-Bit x86).
4. Instanztyp:
   - Für KI-GPU-Inferenz: Wähle `g5.xlarge` (1x NVIDIA A10G mit 24 GB VRAM – perfekt für unser 4-Bit Modell).
   - *Alternativ für reinen Test-Betrieb ohne GPU:* Wähle `t3.xlarge` oder `c6i.xlarge`.
5. Schlüsselpaar (Key Pair):
   - Wähle "Create new key pair".
   - Name: `enterprise-brain-key`
   - Typ: RSA, Dateiformat `.pem`.
   - Lade die `.pem`-Datei herunter und speichere sie ab.
6. Netzwerkeinstellungen:
   - Wähle "Select existing security group" -> wähle `enterprise-brain-sg`.
   - Auto-assign public IP: "Enable" (Aktiviert).
7. Speicher (Storage):
   - Erhöhe die Festplatte auf `50 GiB` Typ `gp3` (wichtig für Modellgewichte und Docker-Container).
8. Klicke auf "Launch instance" (Instanz starten).

---

### PHASE 4: Verbindungsdaten sammeln & formatieren
Warte kurz, bis die Instanz den Status "Running" (Wird ausgeführt) hat. Sammle alle relevanten Daten und gib mir die Antwort EXAKT in folgendem Format zurück, damit ich sie direkt an meinen Coding-Agenten übergeben kann:

```
### 📋 AWS Deployment Ready – Verbindungsdaten:
- **Instance ID:** [Deine Instance-ID, z.B. i-0123456789abcdef0]
- **Public IPv4:** [Deine öffentliche IP-Adresse, z.B. 54.123.45.67]
- **Public DNS:** [Dein Public DNS, z.B. ec2-54-123-45-67.compute-1.amazonaws.com]
- **Region:** us-east-1
- **Security Group:** enterprise-brain-sg
- **Key Pair Name:** enterprise-brain-key.pem

### 🌐 Vorkonfigurierte Links:
- **Hermes Web UI (Mobil & Desktop):** http://[Public-IPv4]:9119
- **Brain REST API:** http://[Public-IPv4]:9200
- **SSH Verbindungsbefehl:** ssh -i "enterprise-brain-key.pem" ubuntu@[Public-IPv4]
```

Starte jetzt mit Phase 1 und führe alle Schritte der Reihe nach aus!
```

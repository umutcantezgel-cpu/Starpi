# AWS Cloud-Architektur & 200 $ Credits-Strategie für das Enterprise Brain

Dieses Dokument zeigt, wie das **AWS-Konto (`codayweb`)** und die **100 $ bis 200 $ Startguthaben** optimal genutzt werden, um das private Enterprise-Brain in der Cloud bereitzustellen, sodass der lokale Laptop komplett entlastet wird.

---

## 💰 1. Strategie: Guthaben von 100 $ auf 200 $ verdoppeln

In Ihrer Konsole unter **„AWS erkunden“** schenkt AWS Ihnen jeweils **20 $ Gutschrift** für das Ausführen folgender 5 Standard-Aktivitäten:

| Aktivität | Prämie | Was zu tun ist |
| :--- | :---: | :--- |
| **1. Einrichten eines Kostenbudgets (AWS Budgets)** | **+20 $** | Erstellen Sie ein Budget von z. B. 20 $ mit E-Mail-Alarm. Schützt vor Überraschungen und schaltet sofort 20 $ Guthaben frei! |
| **2. Starten einer Instance mit EC2** | **+20 $** | Eine kleine Test-Instanz (z. B. Ubuntu t3.micro) starten und stoppen. |
| **3. Basismodell in Amazon Bedrock Playground testen** | **+20 $** | In Amazon Bedrock auf „Playground“ gehen und eine Text-Prompt abschicken. |
| **4. Web-App mit AWS Lambda erstellen** | **+20 $** | Eine einfache Lambda-Beispielfunktion im Browser per Klick anlegen. |
| **5. Aurora- oder RDS-Datenbank erstellen** | **+20 $** | Eine kleine PostgreSQL-Testinstanz (mit pgvector) erstellen. |
| **GESAMT-BONUS** | **+100 $** | **Ihr Gesamtguthaben steigt damit auf 200,00 $ USD!** |

---

## 🛡️ 2. Kosten-Schutz: Budget-Alarm einrichten (Wichtig!)

Um sicherzustellen, dass Sie niemals einen Cent aus eigener Tasche zahlen:
1. In der AWS-Suchleiste oben nach **„AWS Budgets“** suchen.
2. Auf **„Create budget“** klicken.
3. **Template:** *Zero spend budget* oder *Monthly cost budget* wählen.
4. **Amount:** `20.00 USD` eintragen.
5. **Email recipients:** Ihre E-Mail-Adresse eingeben.
6. Sobald 80 % oder 100 % der 20 $ erreicht werden, erhalten Sie sofort eine Warn-Mail. Ihr 100 $ Guthaben deckt diesen Betrag vollständig ab!

---

## 🏗️ 3. Architektur des Enterprise-Brains auf AWS

```
                     📱 Smartphone / 💻 Laptop
                                 │
                                 ▼ (HTTPS)
                      [ AWS EC2 / Lightsail ]
                      ├── Port 9119: Hermes Web UI (Mobil-optimiert)
                      └── Port 9200: Enterprise Brain REST API
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
       [ Supabase Cloud / RDS ]         [ Private KI-Inferenz ]
       PostgreSQL mit pgvector           • Option A: EC2 G5 (vLLM GPU)
       • Automatisches Markdown-Archiv   • Option B: Amazon Bedrock
       • 1536-dim Vektorsuche            • Option C: Lokale GPU bei Bedarf
```

---

## 🤖 4. Das „Agenten-Toolkit für AWS“

Das in Ihrer AWS-Konsole hervorgehobene **Agenten-Toolkit für AWS** ist eine offizielle AWS-Erweiterung für Coding-Agenten:
* **Was es tut:** Es ermöglicht mir (Ihrem KI-Assistenten), über sichere IAM-Berechtigungen direkt Ressourcen auf AWS für Sie zu verwalten, bereitzustellen und zu überwachen.
* **Wie Sie es aktivieren:**
  1. Klicken Sie in der AWS-Konsole auf **„Eingabeaufforderung zur Einrichtung aufrufen“**.
  2. Kopieren Sie den angezeigten Einrichtungs-Code oder generieren Sie einen AWS Access Key.
  3. Damit kann der Agent automatisierte Deployments für Sie ausführen.

---

## 🚀 5. Sofortige Inbetriebnahme

Das Deployment-Skript liegt bereit unter:
[`enterprise-brain/aws/deploy_ec2.sh`](file:///Users/umurey/LocalModels/enterprise-brain/aws/deploy_ec2.sh)

Sobald eine EC2-Instanz auf AWS gestartet ist, richtet dieses Skript das gesamte Enterprise-Brain mit einem einzigen Befehl ein.

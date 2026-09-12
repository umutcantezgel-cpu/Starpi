# AWS Cloud Architektur und Guthaben Strategie für das Enterprise Brain

Dieses Dokument erläutert, wie das AWS Konto (codayweb) und das Startguthaben optimal genutzt werden, um das private Enterprise Brain in der Cloud bereitzustellen, sodass der lokale Rechner vollständig entlastet wird.

## 1. Strategie: Guthaben verdoppeln

In der Konsole unter AWS erkunden vergibt AWS jeweils 20 Dollar Gutschrift für das Ausführen folgender fünf Standardaktivitäten:

| Aktivität | Prämie | Was zu tun ist |
| :--- | :---: | :--- |
| **1. Einrichten eines Kostenbudgets (AWS Budgets)** | **+20 $** | Erstellen Sie ein Budget von beispielsweise 20 $ mit E Mail Alarm. Schützt vor Überraschungen und schaltet sofort 20 $ Guthaben frei! |
| **2. Starten einer Instance mit EC2** | **+20 $** | Eine kleine Testinstanz (beispielsweise Ubuntu t3.micro) starten und stoppen. |
| **3. Basismodell in Amazon Bedrock Playground testen** | **+20 $** | In Amazon Bedrock auf Playground gehen und eine Texteingabe abschicken. |
| **4. Web App mit AWS Lambda erstellen** | **+20 $** | Eine einfache Lambda Beispielfunktion im Browser per Klick anlegen. |
| **5. Aurora oder RDS Datenbank erstellen** | **+20 $** | Eine kleine PostgreSQL Testinstanz (mit pgvector) erstellen. |
| **Gesamter Bonus** | **+100 $** | **Ihr Gesamtguthaben steigt damit auf 200,00 USD!** |

## 2. Kostenschutz: Budget Alarm einrichten

Um sicherzustellen, dass Sie niemals Beträge aus eigener Tasche zahlen:
1. In der AWS Suchleiste oben nach **AWS Budgets** suchen.
2. Auf **Create budget** klicken.
3. **Template:** *Zero spend budget* oder *Monthly cost budget* wählen.
4. **Amount:** `20.00 USD` eintragen.
5. **Email recipients:** Ihre E Mail Adresse eingeben.
6. Sobald 80 Prozent oder 100 Prozent der 20 $ erreicht werden, erhalten Sie sofort eine Warnung per elektronischer Post. Ihr Guthaben deckt diesen Betrag vollständig ab!

## 3. Architektur des Enterprise Brains auf AWS

```
                     Smartphone oder Rechner
                                │
                                ▼ (HTTPS)
                      [ AWS EC2 / Lightsail ]
                      ├── Port 9119: Hermes Web UI
                      └── Port 9200: Enterprise Brain REST API
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
       [ Supabase Cloud / RDS ]       [ Private KI Inferenz ]
       PostgreSQL mit pgvector         • Option A: EC2 G5 (vLLM GPU)
       • Automatisches Markdown Archiv • Option B: Amazon Bedrock
       • 1536 dimensionale Vektorsuche • Option C: Lokale GPU bei Bedarf
```

## 4. Das Agenten Toolkit für AWS

Das in der AWS Konsole hervorgehobene Agenten Toolkit für AWS ist eine offizielle Erweiterung für Coding Agenten:
* **Was es tut:** Es ermöglicht dem Assistenten, über sichere Berechtigungen direkt Ressourcen auf AWS für Sie zu verwalten, bereitzustellen und zu überwachen.
* **Wie Sie es aktivieren:**
  1. In der Konsole auf Eingabeaufforderung zur Einrichtung aufrufen klicken.
  2. Den angezeigten Einrichtungscode kopieren oder einen AWS Access Key generieren.
  3. Damit kann der Assistent automatisierte Bereitstellungen ausführen.

## 5. Sofortige Inbetriebnahme

Das Skript liegt bereit unter:
[`enterprise-brain/aws/deploy_ec2.sh`](file:///Users/umurey/LocalModels/enterprise-brain/aws/deploy_ec2.sh)

Sobald eine EC2 Instanz auf AWS gestartet ist, richtet dieses Skript das gesamte Enterprise Brain mit einem einzigen Befehl ein.

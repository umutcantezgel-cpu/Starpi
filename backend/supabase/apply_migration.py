import os
import time
import httpx

PROJECT_REF = "behnltoogscnbjhvixmw"
ACCESS_TOKEN = os.getenv("SUPABASE_ACCESS_TOKEN", "")
SCHEMA_FILE = os.path.join(os.path.dirname(__file__), "full_schema.sql")

def wait_and_migrate():
    headers = {
        "Authorization": f"Bearer {ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }

    print("==================================================")
    print("   🗄️ Supabase Cloud Auto-Migration               ")
    print(f"   Project: {PROJECT_REF}                        ")
    print("==================================================")

    # 1. Wait for ACTIVE_HEALTHY status
    while True:
        try:
            resp = httpx.get(f"https://api.supabase.com/v1/projects/{PROJECT_REF}", headers=headers, timeout=10.0)
            status = resp.json().get("status")
            print(f"Current project status: {status}")
            if status in ["ACTIVE_HEALTHY", "ACTIVE"]:
                print("✅ Project is ACTIVE_HEALTHY!")
                break
        except Exception as e:
            print(f"Waiting for project... ({e})")
        time.sleep(5)

    # 2. Read full_schema.sql
    with open(SCHEMA_FILE, "r") as f:
        sql_content = f.read()

    print("Applying full_schema.sql with pgvector & RAG RPC...")
    payload = {"query": sql_content}
    
    # Retry loop in case database is just accepting connections
    for attempt in range(1, 10):
        try:
            resp = httpx.post(
                f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query",
                headers=headers,
                json=payload,
                timeout=30.0
            )
            if resp.status_code in [200, 201]:
                print("🎉 Migration successfully executed on Supabase!")
                print(resp.text)
                return True
            else:
                print(f"Attempt {attempt}: {resp.status_code} - {resp.text}")
        except Exception as e:
            print(f"Attempt {attempt} connection error: {e}")
        time.sleep(3)

    return False

if __name__ == "__main__":
    wait_and_migrate()

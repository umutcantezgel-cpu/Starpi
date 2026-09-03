import sys
import json
from .supabase_service import supabase_service
from .embeddings import get_embedding

def main():
    if len(sys.argv) < 2:
        print("Usage: python -m core.cli_supabase [health | list | test-query <text>]")
        sys.exit(1)

    cmd = sys.argv[1].lower()

    if cmd == "health":
        print("🔍 Checking Supabase Health & Schema...")
        result = supabase_service.health_check()
        print(json.dumps(result, indent=2, ensure_ascii=False))

    elif cmd == "list":
        print("📚 Fetching Ingested Documents...")
        docs = supabase_service.list_documents()
        print(f"Total Documents: {len(docs)}")
        for d in docs:
            print(f"  • [{d.get('id')}] {d.get('title')} (Tags: {d.get('tags')})")

    elif cmd == "test-query":
        query = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else "Projekt Alpha"
        print(f"🔎 Testing Vector Similarity Search for: '{query}'")
        vector = get_embedding(query)
        matches = supabase_service.match_sections(vector, threshold=0.1, limit=3)
        print(f"Matches found: {len(matches)}")
        for m in matches:
            print(f"  • {m.get('document_title')} | {m.get('heading')} (Score: {m.get('similarity')})")

    else:
        print(f"Unknown command: {cmd}")

if __name__ == "__main__":
    main()

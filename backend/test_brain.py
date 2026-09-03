import json
from core.ingestion_pipeline import ingest_raw_information
from core.rag import query_brain
from core.supabase_client import db

RAW_TEST_NOTE = """
Meeting Notizen Projekt Alpha - 28. August
Teilnehmer: Alex, Sarah, Michael
Wir haben besprochen dass das neue Feature am 15. September gelauncht wird. 
Budget liegt bei 45.000 EUR. 
Sarah kümmert sich um das Frontend Design in Figma bis zum 5. September. 
Michael baut die Supabase Anbindung für die Vektordatenbank auf Port 5432. 
Wichtig: DSGVO Compliance muss zu 100% sichergestellt sein, keine Nutzerdaten an US-Cloud-Provider ohne Verschlüsselung!
Alex übernimmt das Cloud-GPU Deployment mit vLLM auf einem deutschen Server.
"""

def run_tests():
    print("==================================================")
    print("   🧪 Testing Enterprise Brain Ingestion & RAG     ")
    print("==================================================")

    # 1. Test Ingestion
    print("\n[Step 1] Ingesting unorganized raw meeting note...")
    ingest_result = ingest_raw_information(
        raw_text=RAW_TEST_NOTE,
        source_name="Meeting_Alpha_28Aug.txt",
        source_type="meeting_notes"
    )
    
    print(f"✅ Ingestion Successful!")
    print(f"  • Title: {ingest_result['title']}")
    print(f"  • Summary: {ingest_result['summary']}")
    print(f"  • Tags: {ingest_result['tags']}")
    print(f"  • Chunks created: {ingest_result['sections_count']}")
    print("\n--- Structured Markdown Output ---")
    print(ingest_result['markdown'])
    print("----------------------------------")

    # 2. Test RAG Search
    print("\n[Step 2] Testing Semantic RAG Retrieval...")
    test_queries = [
        "Wer kümmert sich um die Supabase Vektordatenbank und bis wann ist der Launch?",
        "Welche Budgetgrenze und welche DSGVO-Vorgaben wurden für Projekt Alpha festgelegt?"
    ]

    for q in test_queries:
        print(f"\n❓ Frage: '{q}'")
        rag_res = query_brain(q)
        print(f"🤖 Brain Antwort:\n{rag_res['answer']}")
        print(f"📚 Gefundene Quellen ({len(rag_res['sources'])} Abschnitte):")
        for s in rag_res['sources']:
            print(f"   - {s.get('document_title')} | {s.get('heading')} (Similarity: {s.get('similarity')})")

    print("\n==================================================")
    print("   🎉 All Enterprise Brain Tests Completed!       ")
    print("==================================================")

if __name__ == "__main__":
    run_tests()

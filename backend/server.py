import json
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from core.config import config
from core.ingestion_pipeline import ingest_raw_information
from core.rag import query_brain
from core.supabase_client import db

class BrainAPIHandler(BaseHTTPRequestHandler):
    def _set_cors_headers(self, status_code: int = 200, content_type: str = "application/json"):
        self.send_response(status_code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Type", content_type)
        self.end_headers()

    def do_OPTIONS(self):
        self._set_cors_headers(200)

    def do_GET(self):
        parsed_path = urlparse(self.path)
        
        if parsed_path.path == "/api/health":
            self._set_cors_headers(200)
            res = {
                "status": "healthy",
                "service": "Enterprise Brain Core API",
                "supabase_live": db.is_live,
                "llm_endpoint": config.llm_base_url,
                "model": config.llm_model
            }
            self.wfile.write(json.dumps(res, ensure_ascii=False, indent=2).encode("utf-8"))
            
        elif parsed_path.path == "/api/brain/documents":
            self._set_cors_headers(200)
            docs = db.list_documents()
            self.wfile.write(json.dumps({"documents": docs, "count": len(docs)}, ensure_ascii=False).encode("utf-8"))
            
        else:
            self._set_cors_headers(404)
            self.wfile.write(json.dumps({"error": "Endpoint not found"}).encode("utf-8"))

    def do_POST(self):
        parsed_path = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        if parsed_path.path == "/api/brain/ingest":
            raw_text = data.get("text", "")
            source_name = data.get("source_name", "Web-Upload")
            source_type = data.get("source_type", "text")
            
            result = ingest_raw_information(
                raw_text=raw_text,
                source_name=source_name,
                source_type=source_type
            )
            
            self._set_cors_headers(200)
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
            
        elif parsed_path.path == "/api/brain/query":
            user_query = data.get("query", "")
            result = query_brain(user_query=user_query)
            
            self._set_cors_headers(200)
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
            
        else:
            self._set_cors_headers(404)
            self.wfile.write(json.dumps({"error": "Endpoint not found"}).encode("utf-8"))

def run_server(port: int = 9200, host: str = "0.0.0.0"):
    server_address = (host, port)
    httpd = HTTPServer(server_address, BrainAPIHandler)
    print(f"==================================================")
    print(f"   🧠 Enterprise Brain API Server Running         ")
    print(f"   🌐 Listening on: http://localhost:{port}       ")
    print(f"   🗄️ Supabase Live: {db.is_live}                 ")
    print(f"==================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[Enterprise Brain] Shutting down cleanly...")
        httpd.server_close()

if __name__ == "__main__":
    port = config.server_port
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    run_server(port=port)

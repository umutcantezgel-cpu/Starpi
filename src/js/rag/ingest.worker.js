// @ts-check
// Dedicated Ingestion Web Worker for Starpi.
// Handles file parsing, sliding-window chunking, and Okapi BM25 retrieval in background thread.
// Keeps the UI responsive at 60 FPS.

import { BM25Index } from './bm25.js';
import { chunkText } from './chunker.js';
import { parseJsonDocument, parsePdfBuffer } from './parser.js';

const bm25 = new BM25Index();

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};

  try {
    switch (type) {
      case 'PARSE_AND_CHUNK': {
        const { fileName, buffer, textContent, options } = payload;
        const ext = (fileName || '').split('.').pop()?.toLowerCase() ?? '';
        let rawText = '';

        if (buffer instanceof ArrayBuffer) {
          if (ext === 'pdf') {
            rawText = await parsePdfBuffer(buffer);
          } else if (ext === 'json') {
            const decoded = new TextDecoder('utf-8').decode(buffer);
            rawText = parseJsonDocument(decoded);
          } else {
            rawText = new TextDecoder('utf-8').decode(buffer);
          }
        } else if (typeof textContent === 'string') {
          rawText = ext === 'json' ? parseJsonDocument(textContent) : textContent;
        }

        const chunks = chunkText(rawText, options);
        self.postMessage({
          id,
          type: 'PARSE_AND_CHUNK_SUCCESS',
          payload: {
            fileName,
            rawText,
            chunks,
            totalChars: rawText.length,
            chunkCount: chunks.length,
          },
        });
        break;
      }

      case 'INDEX_CHUNKS': {
        const { chunks } = payload;
        if (Array.isArray(chunks)) {
          bm25.addDocuments(chunks);
        }
        self.postMessage({
          id,
          type: 'INDEX_CHUNKS_SUCCESS',
          payload: {
            totalIndexedDocs: bm25.docs.length,
            avgDocLength: bm25.avgDocLength,
          },
        });
        break;
      }

      case 'SEARCH_BM25': {
        const { query, topK, minScore } = payload;
        const results = bm25.search(query, topK ?? 5, minScore ?? 0.01);
        self.postMessage({
          id,
          type: 'SEARCH_BM25_SUCCESS',
          payload: {
            query,
            results,
          },
        });
        break;
      }

      case 'CLEAR_INDEX': {
        bm25.clear();
        self.postMessage({
          id,
          type: 'CLEAR_INDEX_SUCCESS',
          payload: { success: true },
        });
        break;
      }

      default:
        self.postMessage({
          id,
          type: 'ERROR',
          error: `Unknown message type: ${type}`,
        });
    }
  } catch (err) {
    self.postMessage({
      id,
      type: 'ERROR',
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

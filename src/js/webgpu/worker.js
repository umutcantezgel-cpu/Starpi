// WebLLM runs in this dedicated worker so inference never blocks the UI thread and terminating the
// worker deterministically releases the GPU device and every buffer it allocated.
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (message) => handler.onmessage(message);

## Description of Changes
Provide a clear technical explanation of the modifications introduced in this pull request.

## Architectural Area
* [ ] WebGPU Runtime and WGSL Shaders
* [ ] Hardware Profiler (`resolveHardwareTier`)
* [ ] Weight Streaming and Cache API or IndexedDB
* [ ] Vector Search and pgvector Integration
* [ ] Service Worker and Offline PWA Capabilities
* [ ] Backend API and Ingestion Pipelines

## Verification and Testing
Describe how these changes were tested:
* [ ] Validated with `npm run validate`
* [ ] Tested in desktop browser with WebGPU enabled (Chrome, Edge, or Safari)
* [ ] Tested on mobile browser (iOS Safari or Android Chrome)
* [ ] Verified clean VRAM allocation and disposal during model switches without memory leaks

### Benchmark Measurements (if applicable)
* Model evaluated:
* Tokens per second (prefill):
* Tokens per second (decode):
* Peak GPU memory allocation:

## Checklist
* [ ] Code conforms to repository formatting and architectural standards
* [ ] No unhandled GPU buffer allocations or resource leaks
* [ ] Documentation updated where appropriate
* [ ] All commits follow concise, imperative commit messages

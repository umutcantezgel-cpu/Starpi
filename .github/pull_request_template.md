## Description of Changes
Provide a clear technical explanation of the modifications introduced in this pull request.

## Architectural Area
- [ ] WebGPU Runtime & WGSL Shaders
- [ ] Hardware Profiler (`resolveHardwareTier`)
- [ ] Weight Streaming & Cache API / IndexedDB
- [ ] Vector Search / pgvector Integration
- [ ] Service Worker & Offline PWA Capabilities
- [ ] Backend API & Ingestion Pipelines

## Verification & Testing
Describe how these changes were tested:
- [ ] Validated with `npm run validate`
- [ ] Tested in desktop browser with WebGPU enabled (Chrome / Edge / Safari)
- [ ] Tested on mobile browser (iOS Safari / Android Chrome)
- [ ] Verified clean VRAM allocation and disposal during model switches (no memory leak)

### Benchmark Measurements (if applicable)
- Model evaluated:
- Tokens / second (prefill):
- Tokens / second (decode):
- Peak GPU memory allocation:

## Checklist
- [ ] Code conforms to repository formatting and architectural standards
- [ ] No unhandled GPU buffer allocations or resource leaks
- [ ] Documentation updated where appropriate
- [ ] All commits follow concise, imperative commit messages

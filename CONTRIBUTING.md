# Contributing to Starpi

Thank you for contributing to Starpi. This document establishes technical standards, development workflows, and architectural expectations for pull requests, bug fixes, and feature additions.

## Development Principles

1. **Client Side Autonomy**: Maintain absolute privacy and client autonomy. Do not introduce dependencies requiring mandatory server roundtrips for core inference routines.
2. **Deterministic Resource Management**: WebGPU runs within memory constrained browser tabs. Every allocated buffer and pipeline must have an explicit disposal path.
3. **Hardware Portability**: Code must gracefully handle degraded hardware environments, falling back to compact tiers or presenting clear diagnostic errors rather than crashing the browser context.

## Issue Reporting Guidelines

Before opening an issue, verify that the behavior is reproducible and not caused by transient browser cache corruption.

### Bug Reports
* Include full browser version (`navigator.userAgent`).
* Include GPU adapter details: Vendor ID, device description, WebGPU feature flags, and `adapter.limits.maxBufferSize`.
* Provide step by step reproduction steps and browser developer console logs.

### Hardware Incompatibilities
* Use the dedicated Hardware Incompatibility issue template.
* Provide outputs from `chrome://gpu` or `about:support`.
* Specify observed failure mode (such as context loss, device creation failure, shader compilation syntax error, or memory allocation termination).

## Pull Request Workflow

1. **Fork and Branch**:
   * Create feature branches off `main` with descriptive identifiers (`feature/wgsl_matmul_opt`, `fix/vram_unloading_leak`).
2. **Validation**:
   * Run local validation tests before opening a pull request:
     ```bash
     npm run validate
     ```
   * If modifying backend Python services:
     ```bash
     python3 backend/test_brain.py
     ```
3. **PR Description**:
   * Use the standard pull request template located in `.github/pull_request_template.md`.
   * Explain the architectural justification for changes.
   * Provide benchmark measurements (such as tokens per second, memory delta, load time) where performance is affected.

## Code Standards for Core Components

### WebGPU and WGSL Shaders

1. **Memory Alignment**:
   * Respect WGSL structure alignment rules. Uniform buffers must adhere to 16 byte alignment constraints for vector types.
   * Explicitly define buffer usage flags (`GPUBufferUsage.STORAGE`, `GPUBufferUsage.UNIFORM`, `GPUBufferUsage.COPY_DST`) with minimal required permissions.
2. **Device Loss Handling**:
   * Listen for `device.lost` events. Implement recovery or cleanup procedures rather than leaving the application in an unrecoverable hanging state:
     ```javascript
     device.lost.then((info) => {
       console.error(`WebGPU device lost: ${info.message} (Reason: ${info.reason})`);
       cleanupAllocatedBuffers();
     });
     ```
3. **Pipeline Caching**:
   * Reuse `GPUComputePipeline` and `GPUBindGroupLayout` objects across execution runs to avoid redundant compilation overhead during inference loops.

### Memory Management and VRAM Hygiene

1. **Explicit Destruction**:
   * JavaScript garbage collection does not automatically manage GPU memory buffers synchronously. Always invoke `.destroy()` on `GPUBuffer` and `GPURenderBundle` instances when releasing models or context windows:
     ```javascript
     if (buffer) {
       buffer.destroy();
       buffer = null;
     }
     ```
2. **Model Switching Safeguards**:
   * When switching models or precision tiers, the active inference engine instance must be completely dismantled and confirmed dead before instantiating the new runtime. Verify that GPU allocations return to base levels in system task managers.
3. **Context Window Bounds**:
   * Do not exceed declared context window sizes (`context_window_size`) or prefill boundaries (`prefill_chunk_size`). Mobile devices must not exceed 2048 context tokens without explicit user override.

### JavaScript Style and Dependencies

* Standard ECMAScript Modules (ESM) syntax is required.
* Avoid heavy third party UI dependencies; preserve the lean, fast loading architecture of the client.
* Strictly maintain service worker precache manifests when modifying static assets.

---
name: Hardware Incompatibility
about: Report a GPU, WebGPU adapter, or browser failure specific to your device
title: "[HARDWARE]: "
labels: hardware, webgpu
assignees: ''
---

### Hardware Profile
- **Device Model**: [e.g., iPhone 15 Pro, ThinkPad T14s, Custom Desktop PC]
- **GPU Architecture / Model**: [e.g., Apple A17 Pro, Intel Arc A770, AMD Radeon 780M, Mali-G715]
- **Operating System & Kernel**: [e.g., Windows 11 23H2, Android 14, iOS 17.5.1]
- **Browser & Version**: [e.g., Chrome 126.0.6478.62, Safari 17.5]

### WebGPU Adapter Inspection
Paste the output from the browser console after evaluating `await (await navigator.gpu.requestAdapter()).requestAdapterInfo()`:
```json
{
  "vendor": "",
  "architecture": "",
  "device": "",
  "description": ""
}
```

Adapter limits (specifically `maxBufferSize` and `maxStorageBufferBindingSize`):
```text
maxBufferSize:
maxStorageBufferBindingSize:
```

### Observed Behavior
- [ ] `navigator.gpu` is undefined
- [ ] `requestAdapter()` returns null
- [ ] Out of Memory (OOM) / browser tab crashes during model weight allocation
- [ ] Shader compilation failure / WGSL validation error
- [ ] Device lost during inference (`device.lost` triggered)
- [ ] Incorrect token outputs / precision artifacts

### Detailed Symptoms
Explain what happens when attempting to initialize or run inference on this hardware.

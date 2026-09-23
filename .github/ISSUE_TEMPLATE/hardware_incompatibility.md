---
name: Hardware Incompatibility
about: Report a GPU, WebGPU adapter, or browser failure specific to your device
title: "[HARDWARE]: "
labels: hardware, webgpu
assignees: ''
---

### Hardware Profile
* **Device Model**: [such as iPhone 15 Pro, ThinkPad T14s, Custom Desktop PC]
* **GPU Architecture or Model**: [such as Apple A17 Pro, Intel Arc A770, AMD Radeon 780M, Mali G715]
* **Operating System and Kernel**: [such as Windows 11 23H2, Android 14, iOS 17.5]
* **Browser and Version**: [such as Chrome 126.0.6478.62, Safari 17.5]

### WebGPU Adapter Inspection
The **Diagnostics** tab shows the adapter report. Alternatively paste the output of
`(await navigator.gpu.requestAdapter()).info` from the browser console:
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
* [ ] `navigator.gpu` is undefined
* [ ] `requestAdapter()` returns null
* [ ] Browser tab crashes or terminates during model weight allocation
* [ ] Shader compilation failure or WGSL validation error
* [ ] Device lost during inference (`device.lost` triggered)
* [ ] Precision artifacts or abnormal token outputs

### Detailed Symptoms
Explain what happens when attempting to initialize or run inference on this hardware.

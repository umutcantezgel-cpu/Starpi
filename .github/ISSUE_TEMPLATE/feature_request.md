---
name: Feature Request
about: Propose a feature, a new model target, or an architecture improvement
title: "[FEATURE]: "
labels: enhancement
assignees: ''
---

### Feature Summary
A concise explanation of the proposed capability.

### Technical Motivation
Why should this capability be added to Starpi? What limitations does it resolve?

### Proposed Architecture and Implementation
Detail how the feature will be integrated (the relevant section of
[docs/ARCHITECTURE.md](https://github.com/umutcantezgel-cpu/Starpi/blob/main/docs/ARCHITECTURE.md) is a good starting point):
* Affected area: AI layer and providers, chat thread, source check and receipts, workspace and
  citations, retrieval, voice, Live and research, storage and sync, WebGPU engine and model
  selection, server functions (relay, pools, speech), database and RLS, UI and i18n, service worker,
  the local companion or voice server, the library publisher, the `@starpi/core` package, build and
  release
* Privacy impact: does any new data leave the device, and in which mode?
* Memory footprint and VRAM budget impacts (for model changes)

### Alternatives Considered
Describe any alternative solutions or workarounds evaluated.

## 2026-06-14 17:36 (channel: #cyber-dev)
- **User:** said the companion forge/edit size slider didn't stick on save; asked me to update myself on the project and find the cause.
- **You:** Diagnosed a race between the slider's debounced oninput write and the final saveCompanion click (plus the arena ignoring any saved scale). Fixed in v3.1.6: stop writing from updateForgeSize, include scale in saveCompanion, and have addCompanion/_buildCompanion honor it. Committed on `feature/companion-improvements` (bba20a0). Simulated save→reload round-trip verified the scale now sticks.

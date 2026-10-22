# Third-party notices

Linco Harness depends on these MIT-licensed packages. Their source is not vendored in this repository.

- `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` — Copyright (c) 2025 Mario Zechner. https://github.com/earendil-works/pi
- `typebox` — used by Pi for tool schemas.

DeepSeek Harness (Copyright (c) 2026 DeepSeek), Hermes Agent (Copyright (c) 2025 Nous Research), and NVIDIA NeMo Agent Toolkit were read as architecture references. No source from those trees is copied into this repository. Ideas that were adapted — code execution as a tool, a warm worker pool, memory, skills, cron, webhook, approval gates, and an external trace export — are implemented as original Linco modules on top of Pi's agent loop.

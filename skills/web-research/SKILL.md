---
name: web-research
description: Read public web pages and report what they actually say.
---

Use `web_fetch` for a page whose URL you already have.

- Quote only text that came back in the tool result.
- If the page is empty, blocked, or truncated, say so.
- Do not claim you opened an interactive browser. This skill is a read of the HTTP response.
- Prefer one fetch per source, then a short answer that names each URL.

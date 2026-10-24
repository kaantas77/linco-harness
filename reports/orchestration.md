# Linco orchestration

Created: 2026-10-24T04:02:04.242Z
Mode: offline
Performance claim: none. Scripted sleeps are not a DeepSeek ranking.

| Scenario | OK | Workers | Parent | Duration ms | Parent wait ms | Overlap | Succeeded | Failed | Cancelled |
| --- | --- | ---: | --- | ---: | ---: | --- | ---: | ---: | ---: |
| parallel | yes | 2 | succeeded | 452 | 396 | yes | 3 | 0 | 0 |
| sequential | yes | 1 | succeeded | 816 | 777 | no | 3 | 0 | 0 |
| failure | yes | 2 | succeeded | 45 | 3 |  | 2 | 1 | 0 |
| cancel | yes | 2 | cancelled | 68 |  |  | 0 | 0 | 3 |
| restart | yes | 2 | succeeded | 25 |  |  | 2 | 0 | 0 |

## Notes

- Scripted model. These rows are not DeepSeek latency, tokens, cache, or cost.
- Parallel and sequential rows sleep 350 ms inside each child. Wall clock includes process and SQLite overhead.
- Children share the parent workspace. This phase does not give them separate directories.
- A crashed running task is still not reaped. Wake is a single conditional update from waiting_children.

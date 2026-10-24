# Linco planning

Created: 2026-10-24T22:09:20.001Z
Mode: offline
Performance claim: none. Scripted turns are not a DeepSeek ranking.

| Scenario | Mode | OK | Status | Duration ms | Turns | Input | Output |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| dependent | on | yes | succeeded | 83 | 8 | 64 | 16 |
| parallel | on | yes | succeeded | 475 | 9 | 72 | 18 |
| missing-evidence | on | yes | failed | 58 | 3 | 24 | 6 |
| replan | on | yes | succeeded | 57 | 12 | 88 | 22 |
| preserve | on | yes | cancelled | 57 | 2 | 16 | 4 |
| checklist | off | yes | succeeded | 46 | 2 | 16 | 4 |
| compare-note-off | off | yes | succeeded | 45 | 2 | 16 | 4 |
| compare-note-on | on | yes | succeeded | 47 | 4 | 32 | 8 |
| compare-claim-off | off | yes | succeeded | 108 | 1 | 8 | 2 |
| compare-claim-on | on | yes | failed | 64 | 3 | 24 | 6 |

## Notes

- Scripted model. Rows are not DeepSeek latency, tokens, cache, or cost.
- Planning off and on use the same v4 session prefix. The difference is whether the script calls the goal tools.
- A task with no goal still finishes when the model stops. A stored goal finishes only after every required check is verified.
- Token totals are the scripted usage attached to each model turn. Cache was not measured.
- Parallel children sleep 350 ms and share the parent workspace.
- A crash that leaves a child running is not replayed. This bench does not claim exactly-once execution.

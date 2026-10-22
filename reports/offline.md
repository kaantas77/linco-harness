# Linco benchmark

Created: 2026-10-22T14:00:02.305Z
Mode: offline
Model: scripted
Live executed: no
Performance claim: none. These rows are measurements from this run, not a ranking.

Live verification is pending. This file does not contain API latency or cost.

| Runner | Scenario | OK | Status | Duration ms | First response ms | Input | Output | Cache hit | Cache miss | Cost USD |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| linco | write-note | yes | succeeded | 50 |  | 0 | 0 | 0 | 0 | 0.000000 |
| linco | code-list | yes | succeeded | 43 |  | 0 | 0 | 0 | 0 | 0.000000 |
| linco | delete-needs-approval | yes | waiting_approval | 46 |  | 0 | 0 | 0 | 0 | 0.000000 |

## Cache checks

- linco / write-note: first cacheRead n/a, second cacheRead n/a, second call hit n/a, system prompt stable n/a, tool order stable n/a, reasoning preserved n/a. ok
- linco / code-list: first cacheRead n/a, second cacheRead n/a, second call hit n/a, system prompt stable n/a, tool order stable n/a, reasoning preserved n/a. ok
- linco / delete-needs-approval: first cacheRead n/a, second cacheRead n/a, second call hit n/a, system prompt stable n/a, tool order stable n/a, reasoning preserved n/a. ok

## Notes

- Offline rows use the scripted model. They do not measure DeepSeek latency, tokens, or cost.
- Live verification is `linco bench --live`. Until that report says live executed, do not compare runners.

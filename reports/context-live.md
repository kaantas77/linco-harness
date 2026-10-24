# Linco context live comparison

Model: deepseek-flash. Live executed: true. Repeats: 5. Performance claim: none.

| scenario | mode | runs | success | median ms | median first ms | median calls | median in | median out | median cache hit | median USD | compact runs | median chars removed | lost | bad actions |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| file-op | on | 5 | 1.00 | 1933 | 409 | 2 | 541 | 74 | 0.941 | 0.000302 | 0 | 0 | 0 | 0 |
| file-op | off | 5 | 1.00 | 1820 | 433 | 2 | 537 | 74 | 0.941 | 0.000301 | 0 | 0 | 0 | 0 |
| multi-tool | on | 5 | 1.00 | 3156 | 407 | 3 | 710 | 126 | 0.948 | 0.000443 | 0 | 0 | 0 | 0 |
| multi-tool | off | 5 | 1.00 | 3031 | 395 | 3 | 704 | 125 | 0.949 | 0.000439 | 0 | 0 | 0 | 0 |
| session-continue | on | 5 | 1.00 | 4112 | 409 | 4 | 883 | 134 | 0.953 | 0.000538 | 0 | 0 | 0 | 0 |
| session-continue | off | 5 | 1.00 | 3902 | 408 | 4 | 865 | 131 | 0.954 | 0.000526 | 0 | 0 | 0 | 0 |
| two-subagents | on | 5 | 1.00 | 5747 | 395 | 3 | 714 | 409 | 0.951 | 0.000801 | 0 | 0 | 0 | 0 |
| two-subagents | off | 5 | 1.00 | 5647 | 402 | 3 | 704 | 420 | 0.952 | 0.000798 | 0 | 0 | 0 | 0 |
| goal-evidence | on | 5 | 1.00 | 4516 | 406 | 4 | 802 | 369 | 0.958 | 0.000810 | 0 | 0 | 0 | 0 |
| goal-evidence | off | 5 | 1.00 | 4511 | 418 | 4 | 777 | 340 | 0.959 | 0.000749 | 0 | 0 | 0 | 0 |
| long-transcript | on | 5 | 1.00 | 2132 | 420 | 2 | 581 | 86 | 0.950 | 0.000343 | 5 | 379068 | 0 | 0 |
| long-transcript | off | 5 | 1.00 | 2708 | 651 | 2 | 349 | 75 | 0.997 | 0.000840 | 0 | 0 | 0 | 0 |

## Notes

- Each run is a fresh session. Its first model call is a cold prefix. secondUserTurn is the warm turn inside that session.
- secondCallCacheRead is the second model call and is often the tool follow-up of the first user message.
- On and off use the same model, tool list, prompts, and thinking level. On compacts only after 180000 serialized characters.
- Medians are within this sample. One sample is not a ranking.
- Dollar amounts and token counts come from the provider usage on these calls.
- Medians sit on a warm prefix. The first `file-op` on run, before that prefix was warm, read 256 cached tokens and cost $0.001469. Later file runs of the same shape cost about $0.00030.
- `long-transcript` off, repeat 0, sent the uncompacted transcript: 48723 uncached input tokens, 56960 cache-read tokens, $0.015047, 2708 ms. The same transcript on later repeats cache-hit and the median fell to $0.000840. Compaction on removed 379068 serialized characters on every repeat and the five costs were $0.000329 to $0.000756.
- `session-continue` repeat 0, both modes: `secondCallCacheRead` 4352 is the tool follow-up. `secondUserTurnCacheRead` 4608 is the second user message. Those are different calls.
- Short tasks never crossed 180000 characters, so on and off did the same work. Success was 5/5 in every cell. This sample is not a ranking.

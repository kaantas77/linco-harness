# Linco benchmark

Created: 2026-10-22T14:00:38.134Z
Mode: live
Model: deepseek-flash
Live executed: yes
Performance claim: none. These rows are measurements from this run, not a ranking.

| Runner | Scenario | OK | Status | Duration ms | First response ms | Input | Output | Cache hit | Cache miss | Cost USD |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| linco | session-continue | yes | succeeded | 4349 | 488 | 2417 | 178 | 5632 | 2417 | 0.000972 |
| pi | session-continue | yes | succeeded | 4176 | 307 | 1222 | 134 | 1792 | 1222 | 0.000538 |
| linco | file-write | yes | succeeded | 2013 | 327 | 2078 | 72 | 1664 | 2078 | 0.000720 |
| pi | file-write | yes | succeeded | 2106 | 378 | 824 | 62 | 512 | 824 | 0.000325 |
| linco | multi-step | yes | succeeded | 3907 | 311 | 901 | 272 | 7040 | 901 | 0.000639 |
| pi | multi-step | yes | succeeded | 4430 | 357 | 799 | 244 | 2304 | 799 | 0.000546 |
| linco | code-run | yes | succeeded | 2186 | 312 | 455 | 95 | 3328 | 455 | 0.000270 |
| pi | code-run | yes | succeeded | 1911 | 326 | 473 | 85 | 896 | 473 | 0.000249 |

## Cache checks

- linco / session-continue: first cacheRead 0, second cacheRead 1792, second call hit true, system prompt stable true, tool order stable true, reasoning preserved true. ok
- pi / session-continue: first cacheRead 0, second cacheRead 512, second call hit true, system prompt stable true, tool order stable true, reasoning preserved n/a. ok
- linco / file-write: first cacheRead 0, second cacheRead 1664, second call hit true, system prompt stable true, tool order stable true, reasoning preserved n/a. ok
- pi / file-write: first cacheRead 0, second cacheRead 512, second call hit true, system prompt stable true, tool order stable true, reasoning preserved n/a. ok
- linco / multi-step: first cacheRead 1536, second cacheRead 1792, second call hit true, system prompt stable true, tool order stable true, reasoning preserved n/a. ok
- pi / multi-step: first cacheRead 512, second cacheRead 512, second call hit true, system prompt stable true, tool order stable true, reasoning preserved n/a. ok
- linco / code-run: first cacheRead 1536, second cacheRead 1792, second call hit true, system prompt stable true, tool order stable true, reasoning preserved n/a. ok
- pi / code-run: first cacheRead 384, second cacheRead 512, second call hit true, system prompt stable true, tool order stable true, reasoning preserved n/a. ok

## Notes

- One run per scenario on each runner. The numbers are measurements, not a ranking.
- The Pi runner has fs_list, fs_read, fs_write, fs_edit, and code_run. It has no worker, database, memory, or approval gate.
- The Linco runner uses the full tool list, the warm worker, and the session transcript.
- session-continue runs first so its first call is the coldest prefix this process can get. Later scenarios can still hit a prefix cached by an earlier scenario.
- cacheRead is DeepSeek prompt_cache_hit_tokens as reported by Pi. cache miss tokens are Pi's uncached input tokens.
- reasoning preserved is n/a when the model returned no thinking blocks.
- A trailing newline is ignored by the file grader.

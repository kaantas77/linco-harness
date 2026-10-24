# Linco context benchmark

Mode: offline. Model: scripted. Live executed: false. Performance claim: none.

| scenario | mode | ok | status | ms | compacted | before chars | after chars | record kept | detail |
| --- | --- | --- | --- | ---: | --- | ---: | ---: | --- | --- |
| short-on | on | yes | succeeded | 50 | no | 0 | 0 | yes | pear written and the session record kept its earlier text |
| short-off | off | yes | succeeded | 43 | no | 0 | 0 | yes | pear written and the session record kept its earlier text |
| long-on | on | yes | succeeded | 44 | yes | 30595 | 14946 | yes | pear written and the session record kept its earlier text |
| long-off | off | yes | succeeded | 46 | no | 0 | 0 | yes | pear written and the session record kept its earlier text |

## Notes

- Scripted rows prove task success and that the SQLite transcript stays intact. They are not DeepSeek token, cache, or dollar figures.
- Token estimates are serialized characters divided by 4.
- The default request budget stays 180000 characters. The long scripted row uses a smaller budget so compaction is observable without a large fixture.
- A short transcript does not compact. Compaction is pair-safe only when the budget is already exceeded.
- LINCO_COMPACT=0 leaves the stored transcript unchanged on the model request.

# Linco durable workers

Mode: offline. Performance claim: none.

| case | processes | ok | tasks | claim ns | queue ms | recovery ms | renew ns | double runs | lost transcripts | locks | parent/child | detail |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| renew | 0 | yes | 1 | 164917 |  |  | 15519 | 0 | 0 | 0 |  | direct claim, fifty renewals, stale fence rejected |
| pool-1 | 1 | yes | 4 |  | 954 |  |  | 0 | 0 | 0 |  | 1 process pool |
| pool-2 | 2 | yes | 4 |  | 660 |  |  | 0 | 0 | 0 |  | 2 process pool |
| hold | 2 | yes | 1 |  |  | 971 |  | 0 | 0 | 0 |  | settled succeeded |
| write-hold | 2 | yes | 1 |  |  | 874 |  | 0 | 0 | 0 |  | settled needs_inspection |
| parent-child | 2 | yes | 2 |  |  | 886 |  | 0 | 0 | 0 | 1 | child recovered once and the parent continued |
| same-session | 2 | yes | 2 |  |  |  |  | 0 | 0 | 0 |  | the second task waited for the first |

## Notes

- Scripted workers. No DeepSeek call.
- A lease is 800 ms in the crash cases and 15000 ms otherwise. Heartbeats keep a live worker's lease.
- needs_inspection means an uncertain tool already ran. The task is not queued again.
- Exactly-once is not claimed. The fence stops a stale worker from writing. It does not roll back a file that was already written.
- Two processes share one SQLite file on this machine. A network filesystem is not part of this measurement.
- claimCallNs is one direct claim. queueWaitMs is the median time from enqueue to started_at.

# Linco on Boat

Mode: offline. Performance claim: none. This is not a ranking.

The fake API follows Boat's documented disk rule: `/home/user` survives stop and resume, `/tmp` does not, and a stopped disk is kept for 14 days.
No live sandbox was created by this file.

| case | ok | detail |
| --- | --- | --- |
| persist | yes | one sandbox per user; home file survived; /tmp did not; the other user cannot read it |
| limits | yes | expired disk, usage cap, metadata redirect, secret redaction, desktop lock, and idle stop |
| task | yes | one task wrote and read on the sandbox; the host workspace did not change |
| desktop | yes | click waits for approval; text-only models receive the tree; Flash accepts images and Pro does not |
| auth | yes | another user's computer route is 404 and the payload has no Boat credential |

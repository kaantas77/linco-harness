# Backend integration

Phase 11 starts at `aaf3211`. No new frontend and no new agent framework. No public deploy.

## Code-task false negative

Phase 10.6 matrix row `code 2` on `bx_av5296mb` stayed `failed`. The independent check saw `fs_write` and `shell_exec`, and both the source file and stdout contained `PHASE106-RUN-2`. That row stays 9/10. It is not recounted as success.

The verifier was reading a tool-end string clipped to 240 characters. It looked for `exit 0` in that string and treated `exit 1` anywhere in the same text as failure. `shell_exec` already returned `details.exitCode` as a number, and the clip could drop or mix that number with an earlier failed command. A sentence that says `exit 0` could also satisfy the same check.

The tool-end trace now stores a run record beside the clipped text:

- `exitCode` from the process
- `timedOut`
- `stdout`
- `path` for `code_write_run`
- `command` for `shell_exec` and `code_write_run`

A code contract succeeds only when one non-error `code_write_run` or `shell_exec` has `exitCode === 0`, `timedOut` false, a path or command that names the contract file, and stdout that contains the contract token. An earlier failed command does not cancel that record. Text that only says `exit 0` does not count. `echo` of the token does not count. `code_run` does not count. A missing file is a failure. A file read that returns `sandbox_direct_failed` without "no such file" stays `needs_inspection`.

## API

`src/server/http.ts` is the contract. `src/client/linco.ts` polls it. The status values on each task are `queued`, `running`, `waiting_approval`, `waiting_children`, `needs_inspection`, `succeeded`, `failed`, and `cancelled`.

`GET /health` reports `publicReady: false`. Boat Chrome is off unless `LINCO_VM_BROWSER=1`.

Polling `GET /v1/tasks/:id` matches a client that already requests JSON. `GET /v1/tasks/:id/events` is a Server-Sent Events stream of the same status, for a client that can keep a response open. Both stop being interesting once the status is `succeeded`, `failed`, `cancelled`, or `needs_inspection`. `waiting_approval` stays open until the user answers or cancels.

The existing app's source is not in this repo. This phase does not change that app.

## What the API tests cover

Scripted model, no live Boat account:

1. A message returns a `queued` task, then a worker finishes it.
2. A second message in the same session runs after the first.
3. Approval, denial, and cancel go through the HTTP routes.
4. The task view carries usage, traces, and the evidence contract.
5. A secret shaped like `sk-` is removed from that view.
6. A task over `LINCO_TASK_MAX_COST_USD` finishes `failed`.
7. A dead worker's expired lease is queued again by the next process.
8. Another user's token receives 404 for the session, the task, and the computer.
9. One fake Boat sandbox is reused for the same user. A second user gets a different sandbox and cannot read the file. Browser control stays off.

## Cost and disk

One computer row per user. The same user reuses that sandbox. `LINCO_BOAT_IDLE_MS` stops an idle machine when the user has no open task. `LINCO_TASK_MAX_TOKENS` and `LINCO_TASK_MAX_COST_USD` stop one task. Default ceilings are 500000 tokens and 2 USD.

SQLite lives at `$LINCO_DATA_DIR/linco.sqlite`. Copy that file together with its `-wal` and `-shm` siblings, or run `sqlite3 linco.sqlite ".backup 'linco-backup.sqlite'"` while the process is stopped. A network filesystem is not a supported share. Railway needs a persistent volume mounted at `LINCO_DATA_DIR`. This phase does not deploy.

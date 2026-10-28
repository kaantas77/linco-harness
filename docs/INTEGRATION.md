# Integrating an existing app

Linco is the backend. The app keeps its own screens and calls this API. This repo does not contain that app and does not add a frontend.

Use `src/client/linco.ts` or the same requests from the app's HTTP client.

```ts
import { LincoClient } from "./client/linco.js";

const linco = new LincoClient(process.env.LINCO_URL ?? "http://127.0.0.1:8787", process.env.LINCO_TOKEN);
const session = await linco.createSession(userId);
const queued = await linco.sendMessage(session.id, text);
const view = await linco.wait(queued.id);
if (view.task.status === "waiting_approval") {
  const approval = view.approvals.find((item) => item.status === "pending");
  if (approval) await linco.approve(queued.id, approval.id, "approved");
}
```

Poll `GET /v1/tasks/:id` about every few hundred milliseconds. Open `GET /v1/tasks/:id/events` only if the app can hold one response per task. Stop on `succeeded`, `failed`, `cancelled`, or `needs_inspection`. Show `waiting_approval` to the user and post their decision. Read `evidence.runs` for the exit code, stdout, and file. Do not treat the assistant sentence as proof.

Send the next message on the same session id. The worker runs one task per session at a time. Boat mode keeps that user's files on one virtual machine. A different user token cannot read the session, the task, or that machine.

## Private pilot

Set `LINCO_AUTH=token` and give each tester the token from `POST /v1/users`. Leave `LINCO_VM_BROWSER` unset. `GET /health` stays `publicReady: false`. Desktop save and code run are for those testers. Browser control, redirects, and DNS rebinding stay off.

## Process and disk

`linco serve` and `linco worker --data <dir>` share one SQLite file on one machine. `LINCO_DATA_DIR` defaults to `.data`. The file is `linco.sqlite`.

Backup: stop the server and worker, then copy `linco.sqlite`, `linco.sqlite-wal`, and `linco.sqlite-shm`, or run:

```bash
sqlite3 "$LINCO_DATA_DIR/linco.sqlite" ".backup '$LINCO_DATA_DIR/backups/linco.sqlite'"
```

A crashed worker loses its lease. The next worker queues the task again when the trace shows no uncertain side effect. An uncertain tool finishes as `needs_inspection`. This is not exactly-once. A file already written stays written.

One Boat machine per user. The next task for that user reuses it. `LINCO_BOAT_IDLE_MS` stops it after it sits idle with no open task. `LINCO_BOAT_MAX_SECONDS` refuses further commands. `LINCO_TASK_MAX_TOKENS` (default 500000) and `LINCO_TASK_MAX_COST_USD` (default 2) fail the task that crosses them.

## Railway plan

Do not deploy this while `publicReady` is false.

When the pilot gates are closed, the service needs:

| Variable | Role |
| --- | --- |
| `LINCO_AUTH` | `token` |
| `LINCO_HOST` | the public interface, never with `LINCO_AUTH=dev` |
| `LINCO_PORT` | process port. Point it at the platform port. |
| `LINCO_DATA_DIR` | a path on a persistent volume, for example `/data` |
| `LINCO_BOOTSTRAP_TOKEN` | creates the first users |
| `DEEPSEEK_API_KEY` | model |
| `BOAT_API_KEY` | remote computer |
| `LINCO_COMPUTER` | `boat` |
| `LINCO_VM_BROWSER` | leave unset |
| `LINCO_BOAT_TYPE` | `small` |
| `LINCO_BOAT_TTL_SECONDS` | sandbox lifetime |
| `LINCO_BOAT_IDLE_MS` | idle stop |
| `LINCO_BOAT_MAX_SECONDS` | hard stop for commands |
| `LINCO_TASK_MAX_TOKENS` | per-task token ceiling |
| `LINCO_TASK_MAX_COST_USD` | per-task USD ceiling |

Mount a persistent disk at `LINCO_DATA_DIR`. Back that disk up on a schedule. Do not put the SQLite file on an ephemeral container disk. Do not point two replicas at one SQLite file.

This document is the plan. It is not a deployment.

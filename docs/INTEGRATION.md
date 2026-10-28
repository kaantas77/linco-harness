# Integrating an existing app

The app inspected for this phase is the Next.js tree at `/Users/kaantas/weblinco`. It is not part of this repo. Its screens were not changed, and it does not call Linco yet.

What that app does today:

- There is no user account. `app/(agent)/_lib/db.ts` throws, and `app/(agent)/api/conversations/route.ts` returns 501.
- `app/(agent)/page.tsx` sends chat through `useChat` to `POST /api/agent`.
- `app/(agent)/api/agent/route.ts` is the server function that would call Linco. It already reads server environment for its own model key. A Linco bootstrap token belongs in that server environment, not in the browser and not in a client bundle.
- `app/(agent)/_hooks/use-acp-chat.ts` posts to `/api/acp/run` and reads SSE. That hook is a second server entry, not a Linco client.

The harness side of the connection is `POST /v1/app/messages`. The Next server would send the app's user id as `externalUserId`. Linco stores that id, reuses one session, and returns a task view. The view has no Linco token.

```ts
import { LincoClient } from "./client/linco.js";

const linco = new LincoClient(process.env.LINCO_URL ?? "http://127.0.0.1:8787", process.env.LINCO_BOOTSTRAP_TOKEN);
const queued = await linco.sendAppMessage(externalUserId, text);
const view = await linco.watch(queued.task.id, { app: true });
if (view.task.status === "waiting_approval") {
  const approval = view.approvals.find((item) => item.status === "pending");
  if (approval) await linco.approveApp(queued.task.id, approval.id, "approved");
}
```

`watch` follows `GET /v1/app/tasks/:id/events`. If the socket drops, it connects again and the server repeats the current status. `wait` polls `GET /v1/app/tasks/:id` for the same pause and terminal statuses. The next message uses the same `externalUserId` and the same session. Compare `task.status` with `evidence.runs`. The assistant sentence is not the proof.

A user token cannot call `/v1/app/*`. A bootstrap token cannot call `/v1/tasks/:id`. One external id gets one Linco user and one Boat machine.

## Private pilot

Set `LINCO_AUTH=token`. Keep `LINCO_BOOTSTRAP_TOKEN` on the app server. Leave `LINCO_VM_BROWSER` unset. `GET /health` stays `publicReady: false`. Desktop file save and `code_write_run` are for that server. Browser control, redirects, and DNS rebinding stay off.

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

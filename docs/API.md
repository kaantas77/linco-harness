# Linco API

Base URL is the harness server. Token mode requires `Authorization: Bearer <token>`. `LINCO_AUTH=dev` accepts every request and only binds to loopback. A user token that does not own the resource gets 404. A bootstrap token can create users and cannot call the other routes.

`GET /health` returns `publicReady: false` until the pilot gates in `reports/pilot-security.md` are closed.

## Identities

`POST /v1/users` with `{ "name": "Ada" }`. In token mode the response includes a one-time `token`. Store it. It is not shown again.

`POST /v1/sessions` with `{ "userId": "..." }` returns the session. `GET /v1/sessions/:id` returns the session, projected messages, and tasks.

## Tasks

`POST /v1/sessions/:id/messages` with `{ "text": "...", "waitMs": 0, "toolProfile": "auto" }`. `waitMs` 0 returns the queued task. A positive `waitMs` waits until the task leaves the queue or the wait ends. `toolProfile` is `auto`, `agent`, `search`, `browser`, `desktop`, or `code`.

Task status is one of:

- `queued`
- `running`
- `waiting_approval`
- `waiting_children`
- `needs_inspection`
- `succeeded`
- `failed`
- `cancelled`

`GET /v1/tasks/:id` and `GET /v1/tasks/:id/evidence` return the same view:

- `task`
- `approvals`
- `usage` for that task
- `children`
- `traces`
- `evidence.contract` derived from the user text
- `evidence.runs` with `exitCode`, `timedOut`, `stdout`, `path`, and `command` when the tool recorded them

`GET /v1/tasks/:id/events` is `text/event-stream`. Each event is `data: {"id","status","error","resultText"}`. The stream ends on `succeeded`, `failed`, `cancelled`, or `needs_inspection`. A client that already polls should use `GET /v1/tasks/:id` instead. `src/client/linco.ts` polls.

`POST /v1/tasks/:id/cancel` cancels a task that is not already terminal.

`POST /v1/tasks/:id/approve` with `{ "approvalId": "...", "decision": "approved" | "denied" }`. Denial finishes the task as `failed`. Approval queues it again.

`GET /v1/tasks/:id/observe` returns the NeMo trace export.

## Computer, memory, automation, usage

`GET /v1/users/:id/computer` describes the local workspace or the user's Boat machine. `POST /v1/users/:id/computer` ensures that one machine. A second call reuses it.

`GET /v1/users/:id/usage` returns that user's token and USD totals and the ceilings `activeVmPerUser`, `taskMaxTokens`, `taskMaxCostUsd`, and `idleStopMs`.

Memories: `GET` and `POST /v1/users/:id/memories`, `PATCH` and `DELETE /v1/memories/:id`.

Automations: `GET` and `POST /v1/users/:id/automations`.

Notifications: `GET /v1/users/:id/notifications`, `POST /v1/notifications/:id/read`.

Skills: `GET /v1/skills`.

Webhooks: `POST /v1/webhooks/:token`.

Bodies are JSON objects up to 1_000_000 bytes. Responses redact `sk-` and `boat_` secrets.

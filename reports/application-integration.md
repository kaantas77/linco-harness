# Application integration

Phase 12 starts at `8eea783`. No new frontend, no new agent framework, and no live Boat machine. Public use remains NO-GO. Nothing was deployed.

## The existing app

The app is the Next.js tree at `/Users/kaantas/weblinco`. It is outside this repo. Its screens were not edited.

- There is no user account. `app/(agent)/_lib/db.ts` throws, and `app/(agent)/api/conversations/route.ts` returns 501.
- `app/(agent)/page.tsx` sends a message with `useChat` to `POST /api/agent`.
- `app/(agent)/api/agent/route.ts` is the server function that can call Linco later. It already keeps its model key on the server.
- `app/(agent)/_hooks/use-acp-chat.ts` is a second server stream. It is not a Linco client.

weblinco does not call Linco. The harness now exposes the call that server should make.

## Server map

`POST /v1/app/sessions` and `POST /v1/app/messages` take `externalUserId`. The same id reuses one Linco user and one session. The JSON response has no Linco user token and no bootstrap token. A user token receives 403 on `/v1/app/*`. A bootstrap token still receives 403 on `/v1/tasks/:id`.

`src/client/linco.ts` sends those requests. `watch` reads `GET /v1/app/tasks/:id/events`. Each event has an `id` line. A dropped stream is opened again, and the server repeats the current status. `wait` polls. Both stop on `succeeded`, `failed`, `cancelled`, and `needs_inspection`, and both pause on `waiting_approval` and `waiting_children`.

## What the tests checked

The scripted model and `FakeBoat` drove the API. One local `code_write_run` used the real Node process.

| Flow | Status | Separate check |
| --- | --- | --- |
| App message | `succeeded` | `evidence.contract` is null and `evidence.runs` is empty |
| Second message | `succeeded` | same `sessionId`, different task id |
| SSE drop and reconnect | `succeeded` | the second stream still returns that status |
| `proof/app-112.mjs` | `succeeded` | `exitCode` 0, stdout `PHASE112-RUN`, file contains the same text |
| Boat `desk/note.txt` | `succeeded` | text `PHASE112-FILE` after stop and resume; the other user gets "file not found" |
| Approval | `waiting_approval`, then `succeeded` | the file is gone and `sk-` is redacted |
| Denial | `waiting_approval`, then `failed` | the decision is stored on that task |
| Cancel | `queued`, then `cancelled` | `evidence.runs` stays empty |
| Worker restart | `running`, then `succeeded` | result text is `recovered` |
| Second user | `succeeded` on that user's own task | user token is 404 on the first task and 403 on `/v1/app/messages` |

`running` was observed by claiming the queued task before the worker process was replaced. `waiting_children` stays a client pause; `test/resume.test.ts` already reaches that status. `needs_inspection` stays a terminal status in the client. This phase did not open a new live case for it.

The desktop editor path was not marked as a successful nano save. `FakeBoat` does not complete that driver flow. The file that survived stop and resume is the workspace file on that user's machine.

## Browser

`LINCO_VM_BROWSER` stayed off. `desktop_browser`, a Chrome `desktop_window`, a browser `desktop_batch`, `google-chrome`, `chromium`, and a metadata URL were refused before a desktop call or a user command was sent. `node proof/file.mjs` was sent, with `ulimit` in front of it. The first ensure recorded the seal command: `killall` of the Chrome names, removal of both socket paths, and a mode change on the profile path. Stop and ensure recorded that seal a second time.

Same-uid code can still change that mode back. Redirects, subresources, DNS rebinding, and a metadata redirect were not retested. The browser stays off.

## Railway

`docs/INTEGRATION.md` is the deploy plan. No service was started.

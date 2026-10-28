# Private pilot security, phase 12

Public use remains NO-GO. `GET /health` returns `publicReady: false` and `vmBrowser: false`. This phase does not deploy. Phase 10.6 rates stay 10/10, 9/10, and 5/5. They were not rerun.

## Application identity

weblinco has no accounts. The harness maps `externalUserId` on the server and reuses that user's session. `/v1/app/*` accepts the bootstrap token held by the app server. It rejects a user token with 403. The response body does not carry a Linco user token or the bootstrap token. A user token that reads another user's task still receives 404.

## Browser stays off

Removing `vm_browser_*` is not the whole gate. With `LINCO_VM_BROWSER` off:

- `desktop_browser` returns before `openVerifiedPage`.
- `desktop_window` refuses an app name that contains Chrome or Chromium. Another app name still launches.
- `desktop_batch` refuses a browser launch step and does not send it.
- `shell_exec` and `code_write_run` deny `google-chrome`, `chromium`, `chrome-headless-shell`, the control socket, the profile path, a remote-debugging flag, and a metadata address.
- `BoatSandboxManager.desktop`, `desktopSequence`, `withDesktop`, and `run` throw before the desktop call or the user command when `vmBrowser` is false.
- The first ready machine runs a seal outside that denylist: `killall` of those process names, `rm` of `/home/user/.linco/browser.sock` and `/home/user/linco/.linco/browser.sock`, and a mode change on the Chrome profile. Stop followed by ensure runs it again.

`node proof/file.mjs` is still sent. Boat user commands are prefixed with `ulimit` for CPU, process, file, and open-file limits. The trace stores the user command, not that prefix.

The same VM user can change the profile mode back and can build a socket path in a running program. That gap is why the browser process stays off. Redirects, subresources, DNS rebinding, and a metadata redirect were not given a new passing test. They stay open.

## Code, files, and approval

A local `code_write_run` wrote `proof/app-112.mjs`, exited 0, and recorded `PHASE112-RUN` in `evidence.runs`. The task status was checked separately and was `succeeded`. The workspace file contained the same text.

A Boat workspace file `desk/note.txt` contained `PHASE112-FILE` after stop and resume. The second app user has a different machine and cannot read that file. The nano editor flow was not claimed as a pass on the fake desktop driver.

Approval, denial, and cancel go through `/v1/app/tasks/:id`. Denial finishes `failed`. Cancel of a queued task finishes `cancelled`. A tool result that contains an `sk-` key is redacted in the task view. A replaced worker finishes the leased task as `succeeded`.

## Still closed to the public

- Boat Chrome, including redirects, subresources, and DNS rebinding
- Same-uid access if the browser process is turned on
- A metadata redirect that has not been observed as an explicit refusal
- Exactly-once task execution
- A shared SQLite file across machines
- weblinco itself calling this API

`code_write_run` and workspace file save stay available to the app server that holds the bootstrap token. They are not a public launch.

# Private pilot security

Public use remains NO-GO. `GET /health` returns `publicReady: false`. This phase does not deploy.

## Browser control

The private-pilot API does not start Boat Chrome. `LINCO_VM_BROWSER` defaults off. The model is not offered `vm_browser_*`, and `browserAct` refuses before it writes a socket.

If a later operator sets `LINCO_VM_BROWSER=1`, the control socket is `/home/user/.linco/browser.sock`, outside the workspace `/home/user/linco`. The directory is mode `700`. `shell_exec` and `code_write_run` deny a command or a source file that names `browser.sock`, `vm-browser.mjs`, `chrome-profile`, `.linco`, a remote-debugging flag, or a metadata address.

That policy reads the command text and the source text. A program that builds the socket path at runtime can still open it when the browser process is running, because the VM image has one user. The pilot therefore keeps the browser process off. Same-uid isolation is not claimed.

## Redirects, subresources, DNS, metadata

The egress proxy still refuses a private or metadata address on the request it is given. A redirect, a subresource, and a DNS TTL change are not a verified refusal. Phase 10.4 and 10.5 left those gaps open. They stay open. Turning the browser on does not close them.

## Code execution

`code_write_run` writes a workspace file and runs that file through the same shell policy as `shell_exec`. A non-zero exit and a timeout are errors, and their `exitCode`, `timedOut`, `stdout`, `path`, and `command` are stored on the trace. `code_run` stays an in-process interpreter on the API host. It does not satisfy a code contract.

With the browser process off, a workspace program has no Linco control socket to open.

## Users, sessions, and machines

A user token that does not own a session, task, memory, or computer receives 404. Bootstrap tokens cannot call user routes. `LINCO_AUTH=dev` binds only to loopback. Each user has one computer row. A second user gets a different sandbox. Home files stay on that user's disk. `/tmp` does not survive stop.

## Secrets

API responses pass through redaction for `sk-` keys, `boat_` tokens, Boat URLs, and `_token=` query values. The model prompt is not given `DEEPSEEK_API_KEY` or `BOAT_API_KEY`. A tool result that prints one of those shapes is redacted again on the way out.

## Still closed to the public

- Boat Chrome, including redirects, subresources, and DNS rebinding
- Same-uid access to a control socket if the browser is turned on
- A metadata redirect that has not been observed as an explicit refusal
- Exactly-once task execution
- A shared SQLite file across machines

Desktop file save and `code_write_run` stay available to an authorized developer and to token-authenticated test users. They are not a public launch.

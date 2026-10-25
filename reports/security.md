# Linco security

Mode: offline. Performance claim: none.

Sandbox backend: seatbelt.

| case | ok | detail |
| --- | --- | --- |
| auth | yes | anonymous 401, cross-user task cancel approve and memory 404 |
| dev-bind | yes | LINCO_AUTH=dev refuses 0.0.0.0 |
| ssrf | yes | private DNS, loopback default, and metadata redirect blocked |
| sandbox | yes | seatbelt blocked passwd, the other workspace, loopback fetch, and extra mounts |
| fence | yes | expired lease blocked goal, plan, child, transcript, and renew from both processes |

## Notes

- Token auth is the default. `LINCO_AUTH=dev` is the open loopback mode.
- Loopback URLs stay closed unless `LINCO_ALLOW_LOOPBACK=1`.
- The OS sandbox refuses the command when seatbelt or bubblewrap is missing.
- Exactly-once is not claimed. A file written before the fence check is not rolled back.
- Darwin does not get a reliable address-space cap from ulimit. CPU seconds, process count, file size, and wall clock are the limits that are applied.
- Webhook URLs remain a secret capability. They are not a user session.

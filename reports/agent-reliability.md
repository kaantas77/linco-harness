# Agent reliability

Started from `8683678`. Mode `live`. Public use is NO-GO.

Sandbox `bx_thha4kef`. Deleted: true.
Duration 355303 ms. DeepSeek $0.055906. Boat $0.00175.

## Rates

- browser: 1/1
- click: 10/10
- desktop: 0/10
- form: 5/5
- code: 0/5
- subagents: 5/5
- network: 1/2
- cdp: 1/2

## Rows

- pass security/network metadata url [tool] that host is blocked
- miss security/network metadata redirect [tool] https://httpbin.org/redirect-to?url=http://169.254.169.254/latest/meta-data/
- pass security/cdp cdp tcp 9333 [tool] 000 port 9333 closed
- miss security/cdp same user socket [tool] 1000 user srwxr-xr-x 1 user user 0 Oct 27 22:36 /home/user/linco/.linco/browser.sock
- pass controlled/browser controlled open [tool] title Example Domain; url https://example.com/
- pass language/click click 1 [succeeded] tools browser_navigate,browser_click; url https://www.iana.org/help/example-domains
- miss language/desktop desktop 1 [failed] status failed; tools desktop_state
- pass language/form form 1 [succeeded] tools vm_browser_goto,browser_navigate,browser_fill,browser_click
- miss language/code code 1 [failed] status failed; tools none
- pass language/subagents subagents 1 [succeeded] tools task_spawn,task_spawn,task_wait,task_wait; children succeeded,succeeded
- pass language/click click 2 [succeeded] tools browser_navigate,browser_click; url https://www.iana.org/help/example-domains
- miss language/desktop desktop 2 [failed] status failed; tools none
- pass language/form form 2 [succeeded] tools browser_navigate,browser_fill,browser_snapshot,browser_click
- miss language/code code 2 [failed] status failed; tools none
- pass language/subagents subagents 2 [succeeded] tools task_spawn,task_spawn,task_wait,task_wait; children succeeded,succeeded
- pass language/click click 3 [succeeded] tools browser_navigate,browser_click; url https://www.iana.org/help/example-domains
- miss language/desktop desktop 3 [failed] status failed; tools none
- pass language/form form 3 [succeeded] tools browser_navigate,browser_fill,browser_click
- miss language/code code 3 [failed] status failed; tools none
- pass language/subagents subagents 3 [succeeded] tools task_spawn,task_spawn,task_wait,task_wait; children succeeded,succeeded
- pass language/click click 4 [succeeded] tools browser_navigate,browser_click; url https://www.iana.org/help/example-domains
- miss language/desktop desktop 4 [failed] status failed; tools none
- pass language/form form 4 [succeeded] tools browser_navigate,browser_fill,browser_click
- miss language/code code 4 [failed] status failed; tools none
- pass language/subagents subagents 4 [succeeded] tools task_spawn,task_spawn,task_wait,task_wait; children succeeded,succeeded
- pass language/click click 5 [succeeded] tools browser_navigate,browser_click; url https://www.iana.org/help/example-domains
- miss language/desktop desktop 5 [failed] status failed; tools none
- pass language/form form 5 [succeeded] tools browser_navigate,browser_fill,browser_click
- miss language/code code 5 [failed] status failed; tools none
- pass language/subagents subagents 5 [succeeded] tools task_spawn,task_spawn,task_wait,task_wait; children succeeded,succeeded
- pass language/click click 6 [succeeded] tools browser_navigate,browser_click; url https://www.iana.org/help/example-domains
- miss language/desktop desktop 6 [failed] status failed; tools none
- pass language/click click 7 [succeeded] tools browser_navigate,browser_click; url https://www.iana.org/help/example-domains
- miss language/desktop desktop 7 [failed] status failed; tools none
- pass language/click click 8 [succeeded] tools browser_navigate,browser_click; url https://www.iana.org/help/example-domains
- miss language/desktop desktop 8 [failed] status failed; tools none
- pass language/click click 9 [succeeded] tools browser_navigate,browser_click; url https://www.iana.org/help/example-domains
- miss language/desktop desktop 9 [failed] status failed; tools none
- pass language/click click 10 [succeeded] tools browser_navigate,browser_click; url https://www.iana.org/help/example-domains
- miss language/desktop desktop 10 [failed] status failed; tools none

## Blockers

- The redirect left the page on the public redirect URL. The metadata address was not observed, and Chrome did not return an explicit refusal. That is not a verified block.
- The shell and Chrome share uid 1000. The same user can still open the control socket or start its own Chrome. Loopback TCP 9333 is closed; that does not make the browser a separate trust domain. Public use is NO-GO.
- The egress proxy pins the first DNS answer for proxied requests. It does not prove every subresource and does not re-check DNS after a TTL change.

## Notes

- A row is successful only when the action and an independent read agree. The model status is recorded and is not the proof.
- A follow-up on `bx_68aqt37m` added an action hint. Desktop calls then failed in a loop and the tasks were still running at the observation limit. Code tasks only called `fs_read` on a missing file and finished `failed`. Those rows are not in the rates above. The hint was removed; the contract remains.
- The live runner approves Boat tool calls so the matrix can finish. That approval is not the production user prompt.
- Public use stays NO-GO while a blocker remains.

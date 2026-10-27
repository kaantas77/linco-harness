# Release candidate

Started from `0406add`. 2026-10-27T21:45:02.289Z.

Live: yes. Railway variables were injected for this process. Values were not written to the report.
Sandbox: bx_3hbbmdmv. Deleted: yes.
Public use: no. This remains a controlled pilot.

## Adapted from OpenMausBot

- OpenMausBot server/remote-computer.ts CDP_HELPER_SOURCE: Accessibility.getFullAXTree, b{backendNodeId}, fresh snapshot, USER_TAKEOVER_REQUIRED
- OpenMausBot server/computer-proxy.ts open_url and waitForNavigation: a tool reply is not proof
- OpenMausBot gateway/src/execution-router.ts routeExecution: Linco uses a profile on submit, not a second gateway
- OpenMausBot gateway/src/hermes-web.ts: Serper and Tavily adapters fail when the key is unset
- OpenMausBot server/remote-computer.ts computer_batch: desktop_batch stops at the first error under one lock

## Independent results

Browser 14/14. Computer 2/5. Agent 2/2.

- ok controlled browser open https://example.com: verified true; url https://example.com/; title "Example Domain"; snapshot 1
- ok controlled browser open https://example.org: verified true; url https://example.org/; title "Example Domain"; snapshot 2
- ok controlled browser open https://example.com/: verified true; url https://example.com/; title "Example Domain"; snapshot 3
- ok controlled browser open https://httpbin.org/json: verified true; url https://httpbin.org/json; title "httpbin.org/json"; snapshot 4
- ok controlled browser open https://httpbin.org/html: verified true; url https://httpbin.org/html; title "httpbin.org/html"; snapshot 5
- ok controlled browser open http://example.com: verified true; url https://example.com/; title "Example Domain"; snapshot 6
- ok controlled browser click 1: from https://example.com/ to https://www.iana.org/help/example-domains; ref b86; snapshot 7 -> 8
- ok controlled browser click 2: from https://example.com/ to https://www.iana.org/help/example-domains; ref b117; snapshot 9 -> 10
- ok controlled browser click 3: from https://example.com/ to https://www.iana.org/help/example-domains; ref b148; snapshot 11 -> 12
- ok controlled browser click 4: from https://example.com/ to https://www.iana.org/help/example-domains; ref b179; snapshot 13 -> 14
- ok controlled browser form 1: url https://httpbin.org/post; body has token true; snapshot 15 -> 17
- ok controlled browser form 2: url https://httpbin.org/post; body has token true; snapshot 18 -> 20
- ok controlled browser form 3: url https://httpbin.org/post; body has token true; snapshot 21 -> 23
- ok controlled browser stale ref: {"ok":false,"engine":"cdp","error":"that snapshot is stale — call browser_snapshot"} 
- ok controlled computer type 1: calls tools/list,list_apps,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; raw "PHASE103-TYPE-1\n"
- miss controlled computer type 2: calls tools/list,list_apps,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; raw "READ FAILED boat api 400 sandbox_direct_failed"
- miss controlled computer type 3: calls tools/list,list_apps,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; raw "READ FAILED boat api 400 sandbox_direct_failed"
- miss controlled computer type 4: calls tools/list,list_apps,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; raw "READ FAILED boat api 400 sandbox_direct_failed"
- ok controlled computer desktop lock: lock desktop is in use by another task; creates 1
- ok language agent open site: status succeeded; tools browser_open_read,browser_open_read; title "Example Domain"; deepseek 0.000488892
- ok language agent edit file: status succeeded; tools fs_list,fs_write,fs_read; raw "PHASE103-EDIT\n"; deepseek 0.0006299879999999999

Duration 84443 ms. DeepSeek $0.001119. Boat $0.00041. performanceClaim: none.

- The ten-by-ten matrix was split. This run is the subgroup that fits the existing dollar and time caps.
- An earlier deleted sandbox bx_mx9dpp9w opened 6/6 pages and rejected a stale ref. Its link clicks stayed on example.com and its form replies did not contain the token. This run is after that fill and click correction.
- Chrome debug stays on 127.0.0.1:9333. --remote-allow-origins is the loopback origin, not a wildcard. CDP is still reachable by any process inside that VM, so this is a controlled pilot.
- DeepSeek image reading was not repeated. Web evidence is the accessibility snapshot and the final URL.

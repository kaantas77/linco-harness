# Linco on a real Boat computer

Mode: live. Performance claim: none. This is not a ranking.

Railway variables were injected for this process. Values were not written to the report.

Limits set before the run: small, ttl 1500s, max 1200s, boat $0.1, deepseek $0.75.
Sandbox: bx_k26y6st3. Deleted: yes.
MCP tools: list_apps, list_windows, get_window_state, verify_state, launch_app, kill_app, bring_to_front, set_window_frame, invoke_menu, click, double_click, right_click, drag, mouse_button_down, mouse_drag, mouse_button_up, parallel_mouse_drag, type_text, press_key, hotkey, set_value, scroll, clipboard_read, clipboard_write, get_screen_size, get_desktop_state, get_cursor_position, move_cursor, set_agent_cursor_enabled, set_agent_cursor_motion, get_agent_cursor_state, set_agent_cursor_theme, check_permissions, health_report, get_config, set_config, get_accessibility_tree, zoom, page, get_browser_state, browser_prepare, browser_navigate, browser_click, browser_type, browser_dialog, browser_set_input_files, browser_download, browser_pointer, start_recording, stop_recording, get_recording_state, replay_trajectory, install_ffmpeg, start_session, escalate_session, get_session, list_sessions, get_session_state, end_session, check_for_update. Missing assumed tools: none.
States: usage seconds=0 type=small; ready ready; stopped; resumed ready snapshot completed; final-stop.

| scenario | ok | skipped | ms | deepseek usd | boat usd | tools | errors | retries | detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| connect | yes | no | 1735 | 0.000000 | 0.000000 | 0 | 0 | 0 | one sandbox bx_k26y6st3 |
| daemon | yes | no | 454 | 0.000000 | 0.000000 | 0 | 0 | 0 | active / ● cua-driver.service - Cua Driver computer-use daemon / Loaded: loaded (/etc/xdg/systemd/user/cua-driver.service; enabled; preset: enabled) / Active: active (running) since Sun 2026-10-25 18:51:17 UTC; 1s ago / Process: 16748 ExecStartPre=/bin/rm -f /run/ascii-cua/driver.sock (code=exited, status=0/SUCCESS) / Main PID: 16750 (cua-driver) / CGroup: /… |
| mcp-tools | yes | no | 491 | 0.000000 | 0.000010 | 0 | 0 | 0 | listed 60; missing none |
| api-error | yes | no | 229 | 0.000000 | 0.000000 | 0 | 0 | 0 | boat api 404 not_found |
| files | yes | no | 4572 | 0.000450 | 0.000020 | 2 | 0 | 0 | status succeeded; read "PHASE10-FILE" |
| persist | yes | no | 8029 | 0.000000 | 0.000000 | 0 | 0 | 0 | after resume read "PHASE10-FILE" |
| terminal | yes | no | 3989 | 0.000460 | 0.000020 | 2 | 0 | 0 | status succeeded; independent stdout "PHASE10-RUN" exit 0 |
| chrome | no | no | 20873 | 0.002413 | 0.000100 | 11 | 4 | 0 | status succeeded; tree has Example Domain: false |
| desktop-input | no | no | 12014 | 0.001596 | 0.000060 | 5 | 2 | 0 | read "READ FAILED boat api 400 sandbox_direct_failed"; tools desktop_window, desktop_window, desktop_state, desktop_click, desktop_click |
| vision-setup | yes | no | 3673 | 0.000000 | 0.000020 | 0 | 0 | 0 | png bytes 1174; tree contains the code: false; write exit 0; open exit 0 |
| vision | no | no | 3742 | 0.000633 | 0.000020 | 1 | 0 | 0 | model quoted the code: false; image parts sent: 7; image bytes: 971192; accessibility tree contained the code: false; quote "Ekranda Chrome'da açık bir görsel var; siyah zemin üzerinde beyaz kutunun içinde dört karakterli kod görünüyor: **7MVL** (7 – M – V – L olarak okuyorum; ilk karakter yatay çizgili 7, son karakter L). Yalnızca `desktop_screenshot` çağrı… |
| subagents | yes | no | 11642 | 0.002576 | 0.000060 | 10 | 0 | 0 | children 2; alpha "ALPHA-10"; beta "BETA-10"; creates 1 |
| desktop-lock | yes | no | 717 | 0.000000 | 0.000000 | 0 | 0 | 0 | rejected 1; desktop is in use by another task |
| no-retry | yes | no | 348 | 0.000000 | 0.000000 | 0 | 0 | 0 | exit 1; command calls 1 |
| timeout | yes | no | 1344 | 0.000000 | 0.000000 | 0 | 0 | 0 | timedOut true; elapsed 1193 |
| abort | yes | no | 533 | 0.000000 | 0.000010 | 0 | 0 | 0 | aborted |
| other-user | yes | no | 364 | 0.000000 | 0.000000 | 0 | 0 | 0 | other status absent; creates 1; host unchanged true; vm cat exit 1 |

- cua-driver 0.23.2 parsed stdin as JSON. A Content-Length header failed at column 1. This run sent one JSON line per message.
- All eight assumed desktop tool names were in the live tools/list.
- File contents, the node program stdout, the resumed file, the two child files, the single create, the other user row, the host file, the command timeout, the local abort, and the desktop lock were checked outside the model reply.
- get_browser_state did not contain Example Domain.
- desktop_type was not called. Reading proof/typed.txt returned boat api 400 sandbox_direct_failed.
- DeepSeek requests included image parts. The four characters the model returned were not the characters drawn in the PNG.
- usage.seconds was 0 at the first read. usage.dollars moved on later reads. Real sandbox ids use the bx_ prefix. A missing id returned boat api 404 not_found.


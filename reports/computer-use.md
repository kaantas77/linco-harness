# Computer use reliability

Mode: live. Performance claim: none. This is not a ranking and it does not replace the Phase 10 report.

Railway variables were injected for this process. Values were not written to the report.

Started from commit 2f8675b. Protocol: json-lines. Driver errors: isError and error content fail the tool call.
Limits set before the run: small, ttl 1500s, max 1200s, boat $0.1, deepseek $0.75.
Sandbox: bx_5zp78mwa. Deleted: yes.
Chrome 0/5. Desktop typing 5/5. Visual reading 0/5.
Totals: 269902 ms, deepseek $0.013773, boat $0.001020. Boat usage can lag the clock.

## Kept file, terminal, and persistence

| n | ok | ms | tools | errors | retries | deepseek usd | boat usd | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | yes | 740 | write, read, command | 0 | 0 | 0.000000 | 0.000000 | file "PHASE10-FILE"; stdout "PHASE10-RUN" |
| 2 | yes | 3476 | stop, read | 0 | 0 | 0.000000 | 0.000010 | after resume "PHASE10-FILE"; snapshot completed |

## Chrome

| n | ok | ms | tools | errors | retries | deepseek usd | boat usd | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | no | 11344 | tools/list, list_apps, list_windows, launch_app, list_windows, bring_to_front, get_browser_state, start_session, browser_prepare, list_windows, click, hotkey, type_text, press_key, list_windows, get_accessibility_tree, list_windows, get_accessibility_tree, list_windows | 1 | 1 | 0.000000 | 0.000060 | not-loaded; flow refused (browser_route_unavailable): no trusted AT-SPI tree for the approved browser window; the accessibility bus must be reachable to prove which window a control belongs to Found 3 windows: [xid=31457283] pid=Some(17164) "New Tab - Chromium" 945x920+10+50 [xid=4194306] pid=Some(13087) "ascii panel" 1920x40+0+0 [xid=4194307] pid=Some(13087) "ascii dock" 264x76+828+988 204 running process(es), 3 visible window(s) - /sbin/init (pid 1) - kthreadd (pid 2) - pool_workqueue_release  |
| 2 | no | 11665 | tools/list, list_apps, list_windows, bring_to_front, get_browser_state, start_session, browser_prepare, list_windows, click, hotkey, type_text, press_key, list_windows, get_accessibility_tree, list_windows, get_accessibility_tree, list_windows | 1 | 1 | 0.000000 | 0.000060 | not-loaded; flow refused (browser_route_unavailable): no trusted AT-SPI tree for the approved browser window; the accessibility bus must be reachable to prove which window a control belongs to Found 3 windows: [xid=31457283] pid=Some(17164) "New Tab - Chromium" 945x920+10+50 [xid=4194306] pid=Some(13087) "ascii panel" 1920x40+0+0 [xid=4194307] pid=Some(13087) "ascii dock" 264x76+828+988 203 running process(es), 3 visible window(s) - /sbin/init (pid 1) - kthreadd (pid 2) - pool_workqueue_release  |
| 3 | no | 9639 | tools/list, list_apps, list_windows, bring_to_front, get_browser_state, start_session, browser_prepare, list_windows, click, hotkey, type_text, press_key, list_windows, get_accessibility_tree, list_windows, get_accessibility_tree, list_windows | 1 | 1 | 0.000000 | 0.000040 | not-loaded; flow refused (browser_route_unavailable): no trusted AT-SPI tree for the approved browser window; the accessibility bus must be reachable to prove which window a control belongs to Found 3 windows: [xid=31457283] pid=Some(17164) "New Tab - Chromium" 945x920+10+50 [xid=4194306] pid=Some(13087) "ascii panel" 1920x40+0+0 [xid=4194307] pid=Some(13087) "ascii dock" 264x76+828+988 203 running process(es), 3 visible window(s) - /sbin/init (pid 1) - kthreadd (pid 2) - pool_workqueue_release  |
| 4 | no | 9872 | tools/list, list_apps, list_windows, bring_to_front, get_browser_state, start_session, browser_prepare, list_windows, click, hotkey, type_text, press_key, list_windows, get_accessibility_tree, list_windows, get_accessibility_tree, list_windows | 1 | 1 | 0.000000 | 0.000050 | not-loaded; flow refused (browser_route_unavailable): no trusted AT-SPI tree for the approved browser window; the accessibility bus must be reachable to prove which window a control belongs to Found 3 windows: [xid=31457283] pid=Some(17164) "New Tab - Chromium" 945x920+10+50 [xid=4194306] pid=Some(13087) "ascii panel" 1920x40+0+0 [xid=4194307] pid=Some(13087) "ascii dock" 264x76+828+988 203 running process(es), 3 visible window(s) - /sbin/init (pid 1) - kthreadd (pid 2) - pool_workqueue_release  |
| 5 | no | 10322 | tools/list, list_apps, list_windows, bring_to_front, get_browser_state, start_session, browser_prepare, list_windows, click, hotkey, type_text, press_key, list_windows, get_accessibility_tree, list_windows, get_accessibility_tree, list_windows | 1 | 1 | 0.000000 | 0.000060 | not-loaded; flow refused (browser_route_unavailable): no trusted AT-SPI tree for the approved browser window; the accessibility bus must be reachable to prove which window a control belongs to Found 3 windows: [xid=31457283] pid=Some(17164) "New Tab - Chromium" 945x920+10+50 [xid=4194306] pid=Some(13087) "ascii panel" 1920x40+0+0 [xid=4194307] pid=Some(13087) "ascii dock" 264x76+828+988 209 running process(es), 3 visible window(s) - /sbin/init (pid 1) - kthreadd (pid 2) - pool_workqueue_release  |

## Desktop typing

| n | ok | ms | tools | errors | retries | deepseek usd | boat usd | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | yes | 9595 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state, click, type_text, hotkey, press_key | 0 | 0 | 0.000000 | 0.000040 | click true; type_text true; shell wrote the content: no; independent read "PHASE10-TYPE "; driver ok window_id=46137350 pid=19919 elements=1 - [0] window "Terminal" [actions=[activate]]  |
| 2 | yes | 10257 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state, click, type_text, hotkey, press_key | 0 | 0 | 0.000000 | 0.000050 | click true; type_text true; shell wrote the content: no; independent read "PHASE10-TYPE "; driver ok window_id=46137350 pid=20475 elements=1 - [0] window "Terminal" [actions=[activate]]  |
| 3 | yes | 9886 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state, click, type_text, hotkey, press_key | 0 | 0 | 0.000000 | 0.000050 | click true; type_text true; shell wrote the content: no; independent read "PHASE10-TYPE "; driver ok window_id=46137350 pid=20837 elements=1 - [0] window "Terminal" [actions=[activate]]  |
| 4 | yes | 10047 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state, click, type_text, hotkey, press_key | 0 | 0 | 0.000000 | 0.000050 | click true; type_text true; shell wrote the content: no; independent read "PHASE10-TYPE "; driver ok window_id=46137350 pid=21152 elements=1 - [0] window "Terminal" [actions=[activate]]  |
| 5 | yes | 9644 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state, click, type_text, hotkey, press_key | 0 | 0 | 0.000000 | 0.000050 | click true; type_text true; shell wrote the content: no; independent read "PHASE10-TYPE "; driver ok window_id=46137350 pid=21458 elements=1 - [0] window "Terminal" [actions=[activate]]  |

## Visual reading

| n | ok | ms | tools | errors | retries | deepseek usd | boat usd | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | no | 5772 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state | 1 | 0 | 0.000169 | 0.000020 | window png 945x920; sent 945x920 dark 451311; bytes sent 62120; model "5U34"; exact false; tree leaked the code: false |
| 2 | no | 6010 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state | 1 | 0 | 0.000167 | 0.000030 | window png 945x920; sent 945x920 dark 448856; bytes sent 67920; model "KUTO"; exact false; tree leaked the code: false |
| 3 | no | 5845 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state | 1 | 0 | 0.000169 | 0.000030 | window png 945x920; sent 945x920 dark 452580; bytes sent 68684; model "FSSF"; exact false; tree leaked the code: false |
| 4 | no | 5692 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state | 1 | 0 | 0.000167 | 0.000020 | window png 945x920; sent 945x920 dark 447448; bytes sent 68384; model "TMITY"; exact false; tree leaked the code: false |
| 5 | no | 5688 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state | 1 | 0 | 0.000167 | 0.000030 | window png 945x920; sent 945x920 dark 451061; bytes sent 68376; model "X931"; exact false; tree leaked the code: false |

## Natural language

| n | ok | ms | tools | errors | retries | deepseek usd | boat usd | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | no | 34902 | desktop_browser!, desktop_browser!, desktop_state, desktop_click!, desktop_click!, desktop_state, desktop_window!, desktop_window!, desktop_tree!, desktop_click!, desktop_click!, shell_exec | 9 | 0 | 0.002998 | 0.000180 | status succeeded; independent title verified false; quote Görev tamamlanmadı — sonucu olduğu gibi aktarıyorum: **Olanlar** - `desktop_browser` ile https://example.com açmayı denedim: tarayıcı penceresi için güvenilir AT-SPI erişilebilirlik ağacı bulunamadığı için araç reddetti (`browser_route_unavailable`). - Masaüstünü ekran görüntüsüyle kontrol ettim: Chromium açık ama yerel bir dosya gösteriyor (`/home/user/linco/proof/shot-5.png`), yanında nano açık bir terminal var. - Sekmeye tıklama/focus  |
| 2 | no | 13284 | desktop_state, desktop_click!, desktop_click!, desktop_state | 2 | 0 | 0.004227 | 0.000060 | click false; type false; shell false; independent read "PHASE10-TYPE "; status succeeded |
| 3 | no | 5424 | desktop_screenshot | 0 | 0 | 0.001985 | 0.000020 | exact false; screenshot tool true; quote "Ekrandaki görüntüde (Chrome'da açık `shot-5.png`) dört blok harf var: **K93U**. Dosyayı açmadım — yalnızca masaüstü ekran görüntüsündeki piksellerden okudum. Okuma gerekçesi, soldan sağa: 1. **K** — Solda dikey gövde; sağa doğru üst kol yukarı, alt kol aşağı açılıyor. 2. **9** — Üstte kapalı kutu (ilmik), sağ dikey gövde alta iniyor, alt uç sola kıvrık. 3. **3** — Üstte ve altta iki açık yay, ortada içe dönük boğum. 4. **U** — İki dikey yan yana, altta y |
| 4 | yes | 12025 | task_spawn, task_spawn, task_wait, task_wait, fs_read, fs_read, fs_write, fs_read, fs_write, fs_read | 0 | 0 | 0.003723 | 0.000060 | children 2; alpha "ALPHA-10 "; beta "BETA-10 "; creates 1 |


Schemas recorded: 60.
- A failed desktop tool is returned to the model as a failed tool call.
- Shell output is not accepted as the typed file.
- A visual guess is accepted only when the reply is the painted code and the image was a PNG of the viewer window.
- tools/list returned 60 schemas. Arguments are checked against that list before the driver call.
- installed desktop apps: budgie-mouse-panel.desktop code.desktop com.google.Chrome.desktop dev.lizardbyte.app.Sunshine.terminal.desktop gnome-disk-image-mounter.desktop gnome-disk-image-writer.desktop gnome-mouse-panel.desktop google-chrome.desktop nm-connection-editor.desktop org.gnome.Terminal.desktop org.gnome.Terminal.Preferences.desktop --- /usr/bin/google-chrome /usr/bin/nano /usr/bin/gnome-terminal 
- Desktop typing on this sandbox was 5/5. Each trial called click and type_text in gnome-terminal running nano. The shell did not write PHASE10-TYPE. The independent read was PHASE10-TYPE plus a trailing space; trim matched.
- Chrome was 0/5. The window stayed New Tab - Chromium. get_browser_state returned browser_route_unavailable because the accessibility bus had no trusted AT-SPI tree. Address click, ctrl+l, and typing the URL did not change the title. That is a not-loaded result, not a success.
- Visual reading on this sandbox was 0/5. The PNG was a real 945x920 window screenshot and the accessibility tree did not contain the code. DeepSeek Flash's reply was not the painted code. Wrong guesses were not counted.
- Earlier deleted sandbox bx_amtewwdh sent the same uncropped window size and DeepSeek Flash matched the painted code on 2 of 5 trials. The other three replies were different codes. A center crop on deleted sandbox bx_99g7yu93 was 0 of 5. Those rows are not this sandbox's table.

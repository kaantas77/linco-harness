# Computer use v2

Mode: live. Performance claim: none. This is not a ranking and not a bill.

Railway variables were injected for this process. Values were not written to the report.

Started from commit 8712a8f.
Limits set before the run: small, ttl 1500s, max 1200s, boat $0.1, deepseek $0.75.
Sandbox: bx_9tcbmyxj. Deleted: yes.
Browser engine inside the VM: cdp.
Cua existing-profile probe ok: yes. ok; Found 3 windows: [xid=25165827] pid=Some(15272) "Example Domain - Chromium" 945x920+10+50 [xid=2097154] pid=Some(3822) "ascii panel" 1920x40+0+0 [xid=2097155] pid=Some(3822) "ascii dock" 264x76+828+988 174 running process(es), 3 visible window(s) - /sbin/init (pid 1) - kthreadd (pid 2) - pool_workqueue_release (pid 3) - kworker/R-rcu_g (pid 4) - kworker/R-rcu_p (pid 5) - kworker/R-slub_ (pid 6) - kworker/R-netns (pid 7) - kworker/0:0H-events_highpri (pid 9) - kworker/R-mm_pe (pid 12) - rcu_tasks; titles Example Domain - Chromium | ascii panel | ascii dock
AT-SPI: DISPLAY=:0 DBUS=missing node /org/a11y/bus { interface org.freedesktop.DBus.Properties { methods: Get(in s interface_name, in s property_name, out v value); GetAll(in s interface_name, out a{sv} properties); Set(in s interface_name, in s property_name, in v value); signals: user 1907 1090 0 17:41 ? 00:00:00 /usr/libexec/at-spi-bus-launcher user 1914 1907 0 17:41 ? 00:00:00 /usr/bin/dbus-daemon --config-file=/usr/share/defaults/at-spi2/accessibility.conf --nofork --print-address 12 --address=unix
Original PNG detail omitted 0/3. Original PNG detail high 0/3. Desktop screenshot 0/3. Cua screenshot through the Pi image path 1/3.
Totals: 74827 ms, deepseek $0.005214, boat $0.000350.

## Controlled tool flow

| name | ok | ms | tools | deepseek usd | evidence |
| --- | --- | --- | --- | --- | --- |
| cua-chrome | yes | 7843 | tools/list, list_apps, list_windows, launch_app, list_windows, bring_to_front, get_browser_state, start_session, browser_prepare, list_windows, click, hotkey, type_text, press_key, list_windows, get_accessibility_tree | 0.000000 | ok; Found 3 windows: [xid=25165827] pid=Some(15272) "Example Domain - Chromium" 945x920+10+50 [xid=2097154] pid=Some(3822) "ascii panel" 1920x40+0+0 [xid=2097155] pid=Some(3822) "ascii dock" 264x76+828+988 174 running process(es), 3 visible window(s) - /sbin/init (pid 1) - kthreadd (pid 2) - pool_workqueue_release (pid 3) - kworker/R-rcu_g (pid 4) - kworker/R-rcu_p (pid 5) - kworker/R-slub_ (pid 6) - kworker/R-netns (pid 7) - kworker/0:0H-events_highpri (pid 9) - kworker/R-mm_pe (pid 12) - rcu_t |
| example | yes | 2813 | vm_browser_goto, vm_browser_read | 0.000000 | engine cdp; first title "Example Domain"; second title "Example Domain"; url https://example.com/ |
| form | yes | 1478 | vm_browser_fill | 0.000000 | engine cdp; url https://httpbin.org/post; body contains the value true; title "" |
| typing | yes | 8446 | tools/list, list_apps, launch_app, list_windows, bring_to_front, get_window_state, click, type_text, hotkey, press_key | 0.000000 | click true; type_text true; shell wrote the content: no; independent read "PHASE102-TYPE "; trim matched true; driver ok window_id=52428806 pid=16268 elements=1 - [0] window "Terminal" [actions=[activate]]  |
| shared-vm | yes | 3209 | browser-hold, desktop, write, read | 0.000000 | lock desktop is in use by another task; hold ok; file "PHASE102-SHARED"; creates 1 |

## Vision paths

| path | code | ok | px | bytes | dark | decoded | detail | reply | deepseek usd | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| original-omit | DTFW | no | 1228x490 | 14876 | 138240 | yes | omit | OTFW | 0.000121 | original png sent directly; thinking disabled; no desktop and no tool result |
| original-high | DTFW | no | 1228x490 | 14876 | 138240 | yes | high | OTFW | 0.000045 | original png sent directly; thinking disabled; no desktop and no tool result |
| desktop | DTFW | no | 1920x1080 | 89100 | 536708 | yes | high | OTFW | 0.000299 | capture scrot; window title "label-0.png (1228×490)"; page bytes 4453; content |
| cua-tool | DTFW | no | 1100x800 | 49464 | 406433 | yes | pi-default | OTFW | 0.000177 | window "label-0.png (1228×490) - Chromium" 1100x800; tree leaked false; sent through Pi image content |
| original-omit | 3EA8 | no | 1228x490 | 16176 | 156672 | yes | omit | 3E48 | 0.000122 | original png sent directly; thinking disabled; no desktop and no tool result |
| original-high | 3EA8 | no | 1228x490 | 16176 | 156672 | yes | high | ZEH8 | 0.000047 | original png sent directly; thinking disabled; no desktop and no tool result |
| desktop | 3EA8 | no | 1920x1080 | 89364 | 550658 | yes | high | 3EAB | 0.000300 | capture scrot; window title "label-1.png (1228×490)"; page bytes 4709; content |
| cua-tool | 3EA8 | yes | 1100x800 | 49368 | 420383 | yes | pi-default | 3EA8 | 0.000178 | window "label-1.png (1228×490) - Chromium" 1100x800; tree leaked false; sent through Pi image content |
| original-omit | NK6F | no | 1228x490 | 16276 | 140544 | yes | omit | HXEF | 0.000122 | original png sent directly; thinking disabled; no desktop and no tool result |
| original-high | NK6F | no | 1228x490 | 16276 | 140544 | yes | high | HXEF | 0.000047 | original png sent directly; thinking disabled; no desktop and no tool result |
| desktop | NK6F | no | 1920x1080 | 89724 | 538139 | yes | high | MKEF | 0.000299 | capture scrot; window title "label-2.png (1228×490)"; page bytes 4857; content |
| cua-tool | NK6F | no | 1100x800 | 49948 | 407864 | yes | pi-default | MKEF | 0.000177 | window "label-2.png (1228×490) - Chromium" 1100x800; tree leaked false; sent through Pi image content |

## Natural language

These rows are separate from the controlled flow. A model status is not evidence.

| name | ok | ms | tools | deepseek usd | evidence |
| --- | --- | --- | --- | --- | --- |
| example | yes | 5870 | vm_browser_goto!, vm_browser_goto | 0.000518 | status succeeded; tool true; independent title "Example Domain"; quote Sayfa açıldı. - **Başlık:** Example Domain - **URL:** https://example.com/ - İşlem, Boat bilgisayarındaki izole Chrome profilinde (vm_browser_goto) yapıldı; host tarayıcısı kullanılmadı. Başka bir işlem yapmadım, sonuç başlığı göründüğü için durdum. |
| typing | no | 11889 | desktop_state, desktop_click!, desktop_click!, desktop_tree | 0.002764 | status succeeded; click false; type false; shell false; independent read "PHASE102-TYPE " |

- The agent model stays DeepSeek Flash. detail high is a measurement request, not a model change.
- No second vision model was called.
- A browser action runs only as a command inside the user's Boat VM.
- On this sandbox the Cua keyboard path changed the Chromium title to Example Domain. That is one probe, not a five-trial rate.
- The published engine is cdp: playwright-core was not imported, and the isolated Chrome on the VM desktop was driven through 127.0.0.1.
- A deleted sandbox, bx_ek9jw5yf, never started Chrome: the serve command contained `&;` and bash rejected it. Direct vision calls on that run returned empty content because thinking was left on and max_tokens was 64.
- gdbus reached the accessibility bus while DBUS_SESSION_BUS_ADDRESS was unset in that command. Cua can still refuse the existing Chromium window.

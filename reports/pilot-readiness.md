# Pilot readiness

Started from `162b4f9`. 2026-10-27T21:56:42.191Z.

Live: yes. Railway variables were injected for this process. Values were not written to the report.
Sandbox: bx_jhq9jey5. Deleted: yes.
Public use: no.

## Direct channel

saved: readText and cat returned the same file.
Missing file: file-absent: readText returned 400 sandbox_direct_failed and cat found no file. The command API answered.

- execCommand api ok http -  state ready: exit 0 LINCO-CHANNEL /dev/vda1 71909360 21029348 47898844 31% / 0.00 0.00 0.00 
- writeText api ok http -  state ready: written
- readText api ok http -  state ready: CHANNEL-104 
- cat api ok http -  state ready: exit 0 CHANNEL-104 
- readMissing api fail http 400 sandbox_direct_failed state ready: boat api 400 sandbox_direct_failed
- catMissing api ok http -  state ready: exit 1 cat: /home/user/linco/proof/missing-104.txt: No such file or directory 

## Results

Desktop 10/10. Language 4/6. Security 1/3.

- ok controlled type 1: absent true; calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; cat ok  exit 0 PHASE104-TYPE-1 ; readText ok  PHASE104-TYPE-1 ; window ok
- ok controlled type 2: absent true; calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; cat ok  exit 0 PHASE104-TYPE-2 ; readText ok  PHASE104-TYPE-2 ; window ok
- ok controlled type 3: absent true; calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; cat ok  exit 0 PHASE104-TYPE-3 ; readText ok  PHASE104-TYPE-3 ; window ok
- ok controlled type 4: absent true; calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; cat ok  exit 0 PHASE104-TYPE-4 ; readText ok  PHASE104-TYPE-4 ; window ok
- ok controlled type 5: absent true; calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; cat ok  exit 0 PHASE104-TYPE-5 ; readText ok  PHASE104-TYPE-5 ; window ok
- ok controlled type 6: absent true; calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; cat ok  exit 0 PHASE104-TYPE-6 ; readText ok  PHASE104-TYPE-6 ; window ok
- ok controlled type 7: absent true; calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; cat ok  exit 0 PHASE104-TYPE-7 ; readText ok  PHASE104-TYPE-7 ; window ok
- ok controlled type 8: absent true; calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; cat ok  exit 0 PHASE104-TYPE-8 ; readText ok  PHASE104-TYPE-8 ; window ok
- ok controlled type 9: absent true; calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; cat ok  exit 0 PHASE104-TYPE-9 ; readText ok  PHASE104-TYPE-9 ; window ok
- ok controlled type 10: absent true; calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; cat ok  exit 0 PHASE104-TYPE-10 ; readText ok  PHASE104-TYPE-10 ; window ok
- ok security metadata url: that host is blocked
- miss security metadata redirect: {"ok":false,"engine":"cdp","error":"cdp timeout Page.navigate"} 
- miss security cdp same user: chrome https://example.com/; identity 1000 user user ; debug http 200
- ok language open: tools browser_open_read,browser_open_read; title "Example Domain"
- miss language click: status succeeded; tools browser_snapshot
- ok language form: tools browser_navigate,browser_navigate,browser_fill,browser_click,browser_snapshot; body has token
- miss language desktop: status succeeded; tools desktop_state
- ok language code: tools fs_list,fs_write,shell_exec; stdout PHASE104-RUN 
- ok language subagents: tools task_spawn,task_spawn,task_wait,task_wait

## Production blockers

- The metadata redirect did not return a verified refusal. Chrome timed out on Page.navigate, so the redirect is not proven blocked and the metadata URL was not observed.
- A shell in the VM reached Chrome's loopback debug port. The browser user is not separate from the shell user.
- The VM checks the final URL text. It does not resolve DNS again, and it does not inspect subresource requests. That remains a production blocker.

Duration 157768 ms. DeepSeek $0.009524. Boat $0.00076. performanceClaim: none.

- Desktop success requires a new file, click, type_text, and a cat of that token. A model status is not evidence.
- CDP stays on 127.0.0.1:9333. A same-user shell that can open that port is a production blocker.

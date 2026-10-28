# Action execution

Started from `aee60fc`. Mode `live`. Public use is NO-GO.

Diagnosis sandbox `bx_kvp7mkx3` deleted. Matrix sandbox `bx_av5296mb` deleted. Phrase sandbox `bx_hk45dneg` deleted.
Matrix duration 343153 ms. DeepSeek $0.026415. Boat $0.0017.
Phrase duration 115829 ms. DeepSeek $0.006904. Boat $0.00056.
Diagnosis duration 216866 ms. DeepSeek $0.045048. Boat $0.00106.

## Rates

- desktop: 10/10
- code: 9/10
- desktop-phrase: 5/5
- code-phrase: 5/5

## Diagnosis

A fresh desktop session was offered the low-level desktop tools. `priorMessages` was 0. The first stop reason was `toolUse`. The model called `desktop_click` and `desktop_type`. The driver rejected clicks that had coordinates and no window id, and typing that used pid 0. The correction reached the model. `starved` was false. The same desktop session had 87 earlier messages and was still running at the observation limit.

A fresh code session was offered `fs_write` and `shell_exec`. The model called both. The command was `node proof/diag-code.mjs`, the exit code was 0, and stdout contained the token. The same code session did it again. The Phase 10.5 code miss was not an empty tool list.

`desktop_edit_file` runs the Phase 10.4 editor path: create the directory, open nano, click, type, save, then read the file. It returns success only when that read contains the text. `code_write_run` writes the source in the workspace and runs that file in the Boat VM. The result keeps the exit code and stdout. A timeout or a non-zero exit is an error.

## Rows

- pass controlled/desktop controlled desktop [tool] calls tools/list,list_apps,list_windows,launch_app,list_windows,bring_to_front,get_window_state,click,type_text,hotkey,press_key; read back the text; cat exit 0 PHASE106-CONTROL-DESK
- pass controlled/code controlled code [tool] {"content":[{"type":"text","text":"exit 0\nPHASE106-CONTROL-RUN\n"}],"details":{"exitCode":0,"path":"proof/controlled-code.mjs"}}
- pass language/desktop desktop 1 [succeeded] tools desktop_edit_file,fs_read; cat exit 0 PHASE106-TYPE-1
- pass language/desktop desktop 2 [succeeded] tools desktop_edit_file,fs_read; cat exit 0 PHASE106-TYPE-2
- pass language/desktop desktop 3 [succeeded] tools desktop_edit_file,fs_read; cat exit 0 PHASE106-TYPE-3
- pass language/desktop desktop 4 [succeeded] tools desktop_edit_file,desktop_state,fs_read; cat exit 0 PHASE106-TYPE-4
- pass language/desktop desktop 5 [succeeded] tools fs_list,desktop_edit_file,fs_read; cat exit 0 PHASE106-TYPE-5
- pass language/desktop desktop 6 [succeeded] tools fs_list,fs_list,desktop_edit_file,fs_read; cat exit 0 PHASE106-TYPE-6
- pass language/desktop desktop 7 [succeeded] tools desktop_edit_file,fs_read; cat exit 0 PHASE106-TYPE-7
- pass language/desktop desktop 8 [succeeded] tools desktop_edit_file,fs_read; cat exit 0 PHASE106-TYPE-8
- pass language/desktop desktop 9 [succeeded] tools desktop_edit_file,fs_read; cat exit 0 PHASE106-TYPE-9
- pass language/desktop desktop 10 [succeeded] tools desktop_edit_file,fs_read; cat exit 0 PHASE106-TYPE-10
- pass language/code code 1 [succeeded] tools code_write_run; source and stdout have the token
- miss language/code code 2 [failed] tools fs_write,shell_exec; source and stdout have the token
- pass language/code code 3 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code code 4 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code code 5 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code code 6 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code code 7 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code code 8 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code code 9 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code code 10 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code-phrase code phrase 1 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code-phrase code phrase 2 [succeeded] tools fs_list,fs_list,fs_read,code_write_run; source and stdout have the token
- pass language/code-phrase code phrase 3 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code-phrase code phrase 4 [succeeded] tools code_write_run; source and stdout have the token
- pass language/code-phrase code phrase 5 [succeeded] tools code_write_run; source and stdout have the token
- pass language/desktop-phrase desktop phrase 1 [succeeded] tools desktop_state,desktop_edit_file,shell_exec; cat exit 0 PHASE106-PHRASE-D-1
- pass language/desktop-phrase desktop phrase 2 [succeeded] tools desktop_edit_file,fs_read; cat exit 0 PHASE106-PHRASE-D-2
- pass language/desktop-phrase desktop phrase 3 [succeeded] tools desktop_edit_file,fs_read; cat exit 0 PHASE106-PHRASE-D-3
- pass language/desktop-phrase desktop phrase 4 [succeeded] tools desktop_edit_file,fs_read; cat exit 0 PHASE106-PHRASE-D-4
- pass language/desktop-phrase desktop phrase 5 [succeeded] tools fs_list,fs_list,desktop_edit_file,fs_read; cat exit 0 PHASE106-PHRASE-D-5

## Notes

- Diagnosis bx_kvp7mkx3 compared a fresh session with the same session before desktop_edit_file was in the running process. Desktop tools were offered. The model called them. Clicks failed without a window id. Typing failed with pid 0. The correction was sent and was not starved. Code in a fresh session called fs_write and shell_exec, exited 0, and printed the token.
- The published desktop and code rows are from bx_av5296mb. The published desktop phrases are from bx_hk45dneg, after a failed desktop_edit_file still receives one correction that names the path and the text.
- A language row counts only when the tool trace and an independent file or stdout read agree. The model status is not the proof.
- The live runner approves Boat tool calls so the matrix can finish. That approval is not the production user prompt.
- Public use stays NO-GO. The shell can still open browser.sock, and a metadata redirect is not a verified refusal.

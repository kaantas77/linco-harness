---
name: file-ops
description: Create and edit files inside the user workspace.
---

Use the file tools for workspace edits.

- `fs_list` and `fs_read` before changing a file you have not already seen.
- `fs_write` creates or replaces a whole file. `fs_edit` replaces one unique snippet.
- Keep paths relative to the workspace. The tools reject paths that leave it.
- `fs_delete` does not run until the user approves it. If the tool returns an approval error, stop and tell the user. Do not hide the delete inside `shell_exec`.

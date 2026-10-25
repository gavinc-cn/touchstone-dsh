# FS0000_Case name

> Case folder naming: `id_case name`; the id is allocated by the main agent from the root INDEX.md cursor (FS%04d).
> This file is the single authoritative definition of the case.

- **Case ID**: FS0000
- **Interface**: interface under test / API path / CLI command / script entry point (fill in according to the actual shape of the system under test)
- **Category**: Normal scenario / Exception scenario / Boundary scenario
- **Module / Function**: Level-1 category / Level-2 category (must match the directory path)
- **Test objective**: one sentence describing what is to be verified
- **Code reference**: (required) the code location this case targets; when generating the case, the current code is authoritative. Format: file path:line (e.g. src/service/user.py:123-130); separate multiple references with ";"; write full paths (including directories) so that later "code change → retest" screening is easy; after root-cause analysis, write the verdict back here
- **Script**: (optional) fixed script file name; once frozen fill in verify.py; delete this line if not frozen
- **Test method**:
  1. Step 1
  2. Step 2
- **Input parameters**:
  ```json
  { "key": "value" }
  ```
- **Expected output**: what counts as pass, what counts as fail
- **Output retrieval**: direct response / another query interface / database query (provide SQL) / log check (provide path and keyword) / message subscription
- **Verification logic**: how to decide pass (e.g. response code == 0 and body.xxx field is ...)
- **Note**: danger marks ⚠️, skip conditions, design behavior notes, etc.

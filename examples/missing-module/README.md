# A failure the policy already cleared

`requirements.txt` never got `requests`. The build has been red for forty
minutes and the fix is one line.

This class is in `clearance.auto`, so nobody gets paged.

```bash
node bin/interlock.mjs gate examples/missing-module/logs/run-4471.log \
  --root examples/missing-module --repo acme/api --run 4471
```

```
missing-python-module  263819a52f2e
  A Python import is not in the dependency file
  evidence  ModuleNotFoundError: No module named 'requests'
  proposal  add "requests" to requirements.txt
  touches   requirements.txt

  AUTO  class "missing-python-module" is pre-cleared and the change is in scope

--- a/requirements.txt
+++ b/requirements.txt
@@ -1,3 +1,4 @@
 flask==3.0.0
 gunicorn==21.2.0
 pytest==8.0.0
+requests
```

Exit code 0. The patch goes to stdout, so your workflow pipes it straight into
`git apply` and opens the PR.

## Why this one is safe to automate

Three things had to be true, and all three are checked, not assumed:

1. The class is in `clearance.auto` — a person decided that in a reviewed PR.
2. The patch touches `requirements.txt`, which matches `scope.allow` and no
   `scope.deny` glob. Interlock reads the target off the patch it built.
3. One file, one line — under both `limits`.

Break any one and the verdict changes. Rename the target to something matching
`**/*deploy*` and the same failure is refused.

## The honest edge

If `requests` is already pinned, the missing module is not a missing pin — the
install step is broken, and adding the line again would fix nothing:

```
proposal  none — "requests" is already pinned in requirements.txt — the install step is the problem, not the pin
```

Interlock says so and holds, rather than shipping a patch that does nothing.

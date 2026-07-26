# Examples

Two real failures, end to end. Each folder is a tiny repo with its own
`interlock.json`, the files a fix would touch, and the raw GitHub Actions logs.

Run them from the repo root — nothing to install.

| Example | What it shows |
| ------- | ------------- |
| [missing-module](missing-module/) | A failure the policy pre-cleared. Patch out, exit 0, no human. |
| [deprecated-set-output](deprecated-set-output/) | A failure that stops for a person, then stops asking. |

```bash
node bin/interlock.mjs gate examples/missing-module/logs/run-4471.log \
  --root examples/missing-module --repo acme/api --run 4471
```

Running an example writes a ledger to `examples/<name>/.interlock/`. That folder
is gitignored, so you can run them as often as you like. Delete it to start over:

```bash
rm -rf examples/*/.interlock
```

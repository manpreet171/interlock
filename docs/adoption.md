# Adopt it in 30 minutes

No service to run, no database, no account. One JSON file and a CLI.

---

## Minute 0–5 · Scaffold

```bash
cd your-repo
npx github:manpreet171/interlock init
```

You get `interlock.json` and an empty `.interlock/`. Set the owner to a real
person or team — the linter refuses a placeholder, on purpose:

```bash
npx github:manpreet171/interlock lint
```

```
✘ interlock.json — 1 problem
  • owner is still the placeholder — put a real person or team there
```

Fix it, run it again, and you should see:

```
✔ interlock.json is valid
  mode normal · 1 auto · 7 hold · 6 refuse · rules 0a20347304ad
```

---

## Minute 5–10 · Point it at a real failure

Grab the log of a build that actually broke:

```bash
gh run view 4471 --log-failed > run.log
interlock diagnose run.log
```

`diagnose` applies no policy and changes nothing. It tells you what interlock
sees:

```
missing-python-module  263819a52f2e
  A Python import is not in the dependency file
  evidence  ModuleNotFoundError: No module named 'requests'
  proposal  add "requests" to requirements.txt
  touches   requirements.txt
```

Do this on four or five past failures. You will learn two things fast: which
classes your repo actually hits, and whether the default buckets match how your
team feels about them.

---

## Minute 10–15 · Turn on shadow mode

```json
"mode": "shadow"
```

Shadow records a verdict for every failure and blocks nothing. No patch is
emitted, no run is held. It is a week of evidence for free.

Add it to the workflow that already builds you:

```yaml
      - name: interlock
        if: failure()
        run: |
          gh run view "$GITHUB_RUN_ID" --log-failed > run.log
          npx github:manpreet171/interlock gate run.log
        env:
          GH_TOKEN: ${{ github.token }}
```

Then commit the ledger, or push it as an artifact. After a week:

```bash
interlock log
```

Look at the verdicts it *would* have given. If a class is in the wrong bucket,
this is where you find out — cheaply, with nothing at stake.

---

## Day 7 · Switch to normal

```json
"mode": "normal"
```

Now `auto` classes emit a patch and exit 0; `hold` classes exit 75 and wait;
`refuse` classes exit 1.

Wire the exit code into the job so a held run reads differently from a broken
one:

```yaml
      - name: interlock
        if: failure()
        id: gate
        continue-on-error: true
        run: |
          gh run view "$GITHUB_RUN_ID" --log-failed > run.log
          npx github:manpreet171/interlock gate run.log > fix.diff
      - name: open a PR
        if: steps.gate.outcome == 'success'
        run: |
          git checkout -b interlock/fix-$GITHUB_RUN_ID
          git apply fix.diff && git commit -am "fix: automated pipeline repair"
          gh pr create --fill
```

Start conservative. Keep exactly one class in `auto` for the first fortnight.
`missing-python-module` is the usual first choice — the fix is one line, the
target is a dependency file, and it is wrong in a way you would notice within
minutes.

---

## Day 7 onwards · Send holds somewhere a person will see them

```bash
interlock gate run.log --slack | curl -s -X POST -H 'Content-type: application/json' -d @- "$SLACK_WEBHOOK_URL"
```

The payload is Slack Block Kit: the diagnosis, the diff, and two buttons
carrying the exact commands to run.

```bash
interlock clear h-627fdffd --by "Your Name" --reason "checked it"
interlock reject h-627fdffd --by "Your Name" --reason "wrong fix, the pin is intentional"
```

Then apply the cleared patch:

```bash
interlock clear h-627fdffd --quiet | git apply
```

`--quiet` prints only the diff, so it pipes cleanly. It refuses to print
anything for a hold that has not been cleared.

---

## Week 2 · Enforce the policy in CI

Add the linter to your normal build so a bad policy cannot merge:

```yaml
      - run: npx github:manpreet171/interlock lint
```

It exits 1 on any problem: a placeholder owner, an unrouted failure class, a
class in `auto` that has no automatic fix, a warrant window with no end.

Then make policy drift visible in review:

```bash
interlock log --verify
```

Put that in your PR template. When someone loosens `scope.allow`, the diff shows
the rule change and this shows what it costs — which past clearances just died
and which failures go back to a person.

---

## Choosing a mode

| Mode | Auto classes | Holds | Warrants | Use it when |
| ---- | ------------ | ----- | -------- | ----------- |
| `off` | pass | pass | — | You need the gate out of the way right now. |
| `shadow` | recorded | recorded | — | First week. Evidence with nothing at stake. |
| `normal` | patched | wait for a person | honoured | Steady state. |
| `strict` | wait for a person | wait for a person | ignored | An audit, an incident, a repo where nothing is automatic. |

`strict` is the useful one during an incident: every patch gets a person and
past clearances are ignored, without editing a single rule.

---

## No CLI? Use the markdown fallback

If you cannot run Node in the pipeline, copy
[`AGENT-RULES.md`](../AGENT-RULES.md) into your repo and point your coding agent
at it. It states the same four rules in prose.

You lose enforcement, fingerprints and the ledger — it is a policy your agent is
asked to follow rather than one that is checked. It is still better than nothing
written down, and it is a real first step.

---

## Uninstall

Interlock writes exactly two things, both inside your repo:

```bash
rm interlock.json      # the policy
rm -rf .interlock/     # the ledger
```

Then drop the `interlock` steps from your workflow files. Nothing is installed
globally, no state is written outside the repo, no account exists anywhere, and
`npx` leaves nothing behind but its own cache.

Consider keeping `.interlock/ledger.jsonl` even if you stop using the tool — it
is a record of decisions people made, and it stays readable as plain JSON lines
long after the CLI is gone.

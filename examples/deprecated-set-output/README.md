# A failure that stops for a person — once

The workflow still writes `::set-output`. GitHub removed it. The fix is
mechanical, but rewriting someone's release workflow without asking is exactly
the thing nobody wants an agent doing.

So this class sits in `clearance.hold`.

## Run 4502 — it stops

```bash
node bin/interlock.mjs gate examples/deprecated-set-output/logs/run-4502.log \
  --root examples/deprecated-set-output --repo acme/api --run 4502
```

```
set-output-deprecated  1c59f09f5474
  Workflow uses the removed set-output / save-state commands
  evidence  The `set-output` command is deprecated
  proposal  rewrite set-output / save-state as $GITHUB_OUTPUT / $GITHUB_STATE writes
  touches   .github/workflows/build.yml

  HOLD  class "set-output-deprecated" needs clearance

  held as h-627fdffd  →  interlock clear h-627fdffd   or   interlock reject h-627fdffd
```

Exit code **75**. The pipeline is paused, not failed, and there is an id to
argue with. Send it to Slack with `--slack` and the payload arrives with the
diff and two buttons.

## A person looks at it

```bash
node bin/interlock.mjs clear h-627fdffd \
  --root examples/deprecated-set-output \
  --by "Manpreet Singh" --reason "outputs identical, checked both steps"
```

```
✔ cleared h-627fdffd  by Manpreet Singh
  warrant covers fingerprint 1c59f09f5474 for 14 days
  valid only while rules 640490871853 are unchanged

--- a/.github/workflows/build.yml
+++ b/.github/workflows/build.yml
@@ -9,7 +9,7 @@
       - name: Compute version
         id: ver
         run: |
-          echo "::set-output name=version::$(cat VERSION)"
-          echo "::set-output name=short_sha::${GITHUB_SHA::7}"
+          echo "version=$(cat VERSION)" >> "$GITHUB_OUTPUT"
+          echo "short_sha=${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"
       - name: Report
         run: echo "built ${{ steps.ver.outputs.version }} at ${{ steps.ver.outputs.short_sha }}"
  apply with: interlock clear h-627fdffd --quiet | git apply
```

## Run 4530 — three days later, it does not stop

Different day, different run id, different runner path. Same break.

```bash
node bin/interlock.mjs gate examples/deprecated-set-output/logs/run-4530.log \
  --root examples/deprecated-set-output --repo acme/api --run 4530
```

```
  AUTO  warrant h-627fdffd — this exact failure was cleared by Manpreet Singh (use 1/5)
```

That is the whole point. Compare the two logs — the timestamps, the run id and
the checkout path all differ, and both still fingerprint to `1c59f09f5474`,
because everything that varies between runs is stripped before hashing.

A person answered this question once. They do not get asked again.

## The record

```bash
node bin/interlock.mjs log --root examples/deprecated-set-output
```

```
2026-07-26 17:41:55  hold      h-627fdffd  set-output-deprecated  1c59f09f5474
2026-07-26 17:41:55  cleared   h-627fdffd  set-output-deprecated  1c59f09f5474 by Manpreet Singh
2026-07-26 17:41:55  reuse     h-1356e870  set-output-deprecated  1c59f09f5474
```

## Now break the trust

Edit `interlock.json` — add anything to `scope.allow` — and run 4530 again.

It stops. The rules hash changed, so the warrant no longer applies, and a
clearance given under the old rules does not carry into the new ones.

```bash
node bin/interlock.mjs log --verify --root examples/deprecated-set-output
```

```
4 entries  ·  rules in force now: 87d0bb038798
! 3 recorded under rules that no longer apply
  1 past clearance void — those failures go back to a person
! 1 still waiting on a person
  h-1356e870  set-output-deprecated  acme/api run 4530
```

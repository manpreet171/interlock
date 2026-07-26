## What this changes

<!-- One or two sentences. -->

## Does this touch the policy?

If this PR edits `interlock.json`, paste the output of `interlock log --verify`
**after** your change:

```
```

Loosening `scope`, `clearance`, `warrant` or `limits` changes the rules hash and
voids every past clearance. That is not a bug — it is the point — but the
reviewer should see what it costs before approving.

- [ ] `node bin/interlock.mjs lint` passes
- [ ] `node test/run.mjs` passes
- [ ] If a failure class was added or moved, `docs/pillars.md` still matches
- [ ] No new runtime dependency (this stays a zero-dependency CLI)

## For a new failure class

- [ ] A real log line lives in `test/run.mjs` under `CASES`
- [ ] It is routed in the default policy **and** in `schema/policy.schema.json`
- [ ] If it produces a patch, there is a test that the patch survives `git apply`
- [ ] If it does not, the reroute note says what a person should do instead

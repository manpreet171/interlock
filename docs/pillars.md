# The four pillars

Every autofix decision needs four questions answered. `interlock.json` answers
them in advance, in a file someone reviewed.

---

## 1 · Scope — which files may a fix touch?

```json
"scope": {
  "allow": ["requirements*.txt", "package.json", ".github/workflows/*.yml"],
  "deny":  ["**/*deploy*", "**/*release*", "infra/**", "**/*secret*", "**/*.key"]
}
```

Two globs lists. `deny` wins.

**The part most people skip:** scope is checked against the patch interlock
actually built, not against a claim. There is no field where an agent declares
what it intends to modify — interlock reads the target paths off the diff and
compares those. An agent cannot widen its own scope by describing itself
generously, because nothing it says is consulted.

This is why the same failure gets different verdicts in different places:

```
touches .github/workflows/build.yml     →  AUTO
touches .github/workflows/release.yml   →  REFUSE  (matches **/*release*)
```

Identical error, identical class, identical fix. One is in scope and one is not,
and the decision comes from the file path in the diff.

**Setting it:** start with `deny`. Write down what you would never want touched
while half asleep — deploy workflows, infrastructure, anything holding a
credential. Then make `allow` as narrow as you can stand. Dependency manifests
and non-deploy workflow files are a reasonable first week.

---

## 2 · Signature — what broke, named the same way every time?

Interlock reads a raw CI log and reduces it to a class and a fingerprint:

```
missing-python-module  263819a52f2e
```

The **class** is one of fourteen known shapes of CI failure. Eleven of them have
no automatic fix, and interlock says so rather than improvising one.

The **fingerprint** is a hash of the class plus the failure's evidence, after
everything that varies between runs has been stripped: timestamps, run ids,
runner paths, commit hashes, line and column numbers, durations.

That normalisation is the whole trick. Two runs of the same break:

```
2026-07-21T11:02:44.7710223Z ##[warning]The `set-output` command is deprecated…
2026-07-24T18:47:10.0021994Z ##[warning]The `set-output` command is deprecated…
```

Different day, different run, different runner. Both fingerprint to
`1c59f09f5474`. A genuinely different failure does not, and no amount of log
noise makes two different breaks collide.

**Why it matters:** a fingerprint is what makes an approval *specific*. Without
it the only approvals you can express are "yes, this once" and "yes, forever."
With it you get the one people actually want — **"yes, to this."**

**The part most people skip:** the fingerprint is derived from the log, so it
cannot be forged by the thing asking for permission. You cannot accidentally
approve a class of future changes, because the approval is bound to evidence
that already exists.

---

## 3 · Clearance — who says yes, and does a past yes still count?

Every failure class lands in exactly one bucket. The linter fails if one is
unrouted, so there is no accidental default.

```json
"clearance": {
  "auto":   ["missing-python-module"],
  "hold":   ["set-output-deprecated", "lockfile-drift", "unknown", "…"],
  "refuse": ["missing-secret", "runner-oom", "test-failure", "…"]
}
```

| Bucket | Meaning | Exit |
| ------ | ------- | ---- |
| `auto` | Fixed without asking. Only classes with a deterministic fix are allowed here. | 0 |
| `hold` | Paused. A person clears or rejects it. | 75 |
| `refuse` | No agent may patch this, ever. | 1 |

Exit 75 is deliberate: it means *waiting*, not *failed*. Your workflow can treat
a held run differently from a broken one.

### Warrants

When a person clears a hold, that decision is stored against the fingerprint:

```
✔ cleared h-627fdffd  by Manpreet Singh
  warrant covers fingerprint 1c59f09f5474 for 14 days
  valid only while rules 640490871853 are unchanged
```

Next time the *same* failure appears, interlock finds the warrant and clears it
without asking again. A different failure never matches.

```json
"warrant": { "reuse": true, "expires_after_days": 14, "max_uses": 5 }
```

A warrant dies four ways: it expires, it runs out of uses, someone changes the
rules, or the mode is `strict`.

**The part most people skip:** the rules clause. The `rules` value is a hash of
the enforcing parts of your policy — scope, clearance, warrant, limits, mode.
Change any of them and every past clearance stops applying, and those failures
go back to a person. Edit the `owner` field or the `$schema` line and warrants
survive, because neither changes what is enforced.

That is the difference between an audit trail and a real control. A permission
granted under one set of rules should not silently survive into another.

### Limits

```json
"limits": { "max_files_changed": 2, "max_lines_changed": 20 }
```

A ceiling on size. A patch over the limit is held rather than auto-cleared, even
if its class is pre-cleared. Small mechanical fixes stay automatic; anything
that grew unexpectedly gets a person.

---

## 4 · Record — what happened, written where it can be checked?

Every decision appends one JSON line to `.interlock/ledger.jsonl`:

```json
{"seq":2,"ts":"2026-07-26T17:41:55.291Z","event":"cleared","of":"h-627fdffd",
 "fingerprint":"1c59f09f5474","class":"set-output-deprecated","by":"Manpreet Singh",
 "reason":"outputs identical, checked both steps","rules":"640490871853","mode":"normal"}
```

Every entry carries the fingerprint, the rules hash in force at that moment, the
verdict, and the reason in words. Clearances also carry who signed them —
`clear` refuses to run without a name.

**Commit it.** The ledger is the answer to "who let the robot do that", and it
is worth nothing if it lives on a runner that was destroyed after the job.

```bash
interlock log --verify
```

```
4 entries  ·  rules in force now: 87d0bb038798
! 3 recorded under rules that no longer apply
  1 past clearance void — those failures go back to a person
! 1 still waiting on a person
  h-1356e870  set-output-deprecated  acme/api run 4530
```

**The part most people skip:** `--verify` reads the record against the policy as
it stands *today*. It answers a question a plain log cannot — *would we still
allow the things we allowed last month?* When someone loosens the policy in a
PR, that line is what shows the cost.

---

## How they fit together

```
log ──► Signature ──► what broke, named stably
         │
         ├─► Clearance ──► auto | hold | refuse   (by class)
         ├─► Scope     ──► refuse if the patch lands somewhere it may not
         ├─► Limits    ──► hold if the patch is bigger than expected
         └─► Warrant   ──► auto if this exact failure was cleared before
                             │
                             └─► Record ──► every one of the above, appended
```

Refuse always wins. Scope is checked before size. A warrant is the last thing
consulted, and it can only turn a hold into an auto — never a refuse.

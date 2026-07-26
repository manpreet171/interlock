# Rules for an agent fixing this pipeline

Copy this file into your repo and point your coding agent at it when you cannot
run the CLI in your pipeline.

This is the honest version of interlock: the same four rules, stated in prose,
followed on trust. You lose enforcement, fingerprints and the ledger. You keep
the thing that matters most — the rules exist in writing and someone approved
them.

---

## 1 · Scope — what you may change

You may propose changes to:

- dependency manifests (`requirements*.txt`, `package.json`, `package-lock.json`)
- non-deploy workflow files (`.github/workflows/*.yml`)

You may never change, for any reason:

- anything with `deploy`, `release` or `secret` in its path
- infrastructure (`infra/**`, `terraform/**`)
- credentials of any kind (`*.pem`, `*.key`, `.env`)

If your fix requires touching something outside the first list, **stop and say
so.** Do not find a way around it, do not fix a different file to achieve the
same effect, and do not ask for the rule to be relaxed in the same message where
you propose the change.

## 2 · Signature — say what broke before you say how to fix it

State, in this order, before proposing anything:

1. The failure class in one hyphenated phrase (`missing-python-module`).
2. The exact log line you concluded it from — quoted, not paraphrased.
3. The fix, as a diff.

If you cannot quote a line, you have not diagnosed it. Say that instead of
guessing.

## 3 · Clearance — what you may do alone

**Fix without asking** — only failures where the correct fix is mechanical and
has exactly one right answer:

- an import missing from a dependency file
- a workflow command that has a documented replacement

**Stop and ask a person** — everything else that is fixable, including every
dependency conflict, every lockfile problem, and anything you are unsure about.
Present the diff and wait.

**Never touch** — do not attempt a fix for any of these:

| Failure | Why not |
| ------- | ------- |
| A missing secret or credential | A person walks to a settings page. Never write a secret. |
| Out of memory, out of disk, job timeout | The fix is infrastructure, not code. |
| A failing test | The pipeline is working. A red test is information, not a bug to patch away. |
| A syntax error in application code | That is a code bug. Fix it as a code bug, not as a pipeline repair. |

## 4 · Record — leave a trail

Every proposal must state:

- what broke and the line you read it from
- which files the fix touches, listed explicitly
- which rule above allows you to touch them
- what you are unsure about

Put it in the PR description. If nobody could reconstruct your reasoning from
that text alone, write more.

---

## Things that are always wrong

- Guessing a version number. If an action or a package is deprecated, report it
  and stop. Someone has to check what the right version is.
- Making a test pass by changing the test.
- Widening scope to fit the fix you already wrote.
- Retrying the same failed fix with different wording.
- Describing a change as smaller than it is.

## When you are unsure

Say so and stop. An honest "I do not know what caused this" costs somebody five
minutes. A confident wrong patch to a build pipeline costs an afternoon, and it
costs the team their willingness to let anything automatic near the pipeline
again.

---

Enforced version: [interlock](https://github.com/manpreet171/interlock) —
`npx github:manpreet171/interlock init`

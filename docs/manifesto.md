# The agent was never the hard part

Writing an agent that fixes a broken build is a weekend. Read the log, spot the
missing import, write the line, open the PR. Models have been good enough at
that for a while.

The hard part is the sentence nobody wants to say out loud:

> *This program has commit access to our pipeline and we have not written down
> what it may do with it.*

That is not a capability problem. It is an authority problem, and authority
problems do not get solved by a better prompt.

## We already govern this — just too late

Branch protection, `CODEOWNERS`, required reviews, environment approvals. These
are good. Most teams have them and they work.

But look at *when* they fire. Every one of them acts on a pull request that
already exists. By then the interesting decision — *should anything have been
changed at all?* — is behind us. The reviewer is handed a diff and a yes/no
button, usually at the end of a long day, usually on something that looks
plausible.

For a human contributor that is fine. A human had a reason, and you can ask
them. For an agent that opened forty PRs this week, "looks plausible" is the
entire review.

The gap is one step earlier: **the moment the fix is proposed.** Nothing in a
normal repo describes that moment. There is no file that says which failures may
be patched without asking, which need a person, and which nothing automated
should touch under any circumstances.

## The two answers people actually pick

**Fully autonomous.** The agent reads, patches, and merges. This works
beautifully until the day it rewrites a deploy workflow at 2am because a
transient network error looked like a config bug. The blast radius of "mostly
right" is not small when the thing being patched is how you ship.

**Fully manual.** What most teams do. A dependency pin goes stale, the build
goes red, and a senior engineer spends the afternoon reading logs to discover a
one-line fix. It is safe and it is a waste of the best person on the team.

Both answers come from treating this as a question about *trust in the model*.
It isn't. Nobody asks whether they trust a junior engineer in the abstract —
they give them access to some things and not others, and they write it down.

## The third answer

Write the authority down. Make it a file in the repo, reviewed like code.

```
interlock.json  →  what an agent may change when CI breaks
```

Four questions, settled in advance, in a diff someone approved:

- **Scope** — which files may a fix touch?
- **Signature** — what broke, named the same way every time?
- **Clearance** — who says yes, and does a past yes still count?
- **Record** — what happened, written where it can be checked?

Then a gate that enforces it and a ledger that remembers. The agent proposes.
The policy decides. A person clears what the policy will not.

The useful property is not that it blocks things. It is that **every decision
has a reason you can read and disagree with.** When something goes wrong, the
question stops being "why did the AI do that" and becomes "which rule allowed
this, and who approved it" — a question with an answer.

## What this will never do

A safety tool that quietly relaxes is worse than no safety tool, because you
stop watching it. So:

**It never widens its own scope.** Scope is read off the patch interlock built,
not off anything the agent claims about itself. A fix that would touch a denied
file is refused even when its failure class is pre-cleared.

**It never guesses a version number.** A deprecated action needs a version
someone has checked. Interlock reports it and stops. Confidently wrong version
bumps are how automation loses a team's trust in one afternoon.

**It never writes a secret.** Missing credentials are on the refuse list and
will stay there. That is a person walking to a settings page, not a patch.

**It never carries a clearance across a rule change.** Loosen the policy and
every past approval dies with it. A clearance is only meaningful under the rules
it was given in.

**It never turns a red test green.** A failing test is the pipeline working. It
is information, not a bug to be patched away.

## The one-sentence version

An agent fast enough to fix your pipeline is fast enough to break it, and the
difference between those two outcomes is a file you have not written yet.

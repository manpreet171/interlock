// End-to-end tests. No dependencies, no framework — it runs the real CLI.
// node test/run.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLI = path.join(REPO, "bin", "interlock.mjs");

let pass = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (e) {
    failures.push({ name, message: e.message });
    process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`);
  }
}

function eq(actual, expected, what) {
  if (actual !== expected)
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

function il(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd || REPO,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...(opts.env || {}) },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function json(args, opts) {
  const r = il([...args, "--json"], opts);
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Error(`expected JSON from "${args.join(" ")}", got:\n${r.out}`);
  }
}

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "interlock-test-"));
  return d;
}

// Never copy a ledger into a fixture — a stale warrant would silently
// pre-approve things the test meant to gate.
function copy(from, to) {
  fs.cpSync(from, to, { recursive: true, filter: (src) => !src.includes(".interlock") });
}

const EX_MOD = path.join(REPO, "examples", "missing-module");
const EX_OUT = path.join(REPO, "examples", "deprecated-set-output");

// ------------------------------------------------------------------ policy

console.log("\npolicy");

test("the repo's own policy is valid", () => {
  const r = il(["lint"]);
  eq(r.code, 0, "exit code");
  ok(r.out.includes("is valid"), "output should say valid");
});

test("every example policy is valid", () => {
  for (const dir of [EX_MOD, EX_OUT]) {
    const r = il(["lint", path.join(dir, "interlock.json")]);
    eq(r.code, 0, `${path.basename(dir)} exit code — ${r.out}`);
  }
});

test("lint exits 1 on a bad policy (CI-friendly)", () => {
  const d = tmp();
  il(["init"], { cwd: d });
  const r = il(["lint"], { cwd: d });
  eq(r.code, 1, "a freshly scaffolded policy still has a placeholder owner");
  ok(r.out.includes("owner"), "should name the owner problem");
});

test("lint rejects an unrouted failure class", () => {
  const d = tmp();
  il(["init", "--owner", "me@example.com"], { cwd: d });
  const p = JSON.parse(fs.readFileSync(path.join(d, "interlock.json"), "utf8"));
  p.clearance.refuse = p.clearance.refuse.filter((c) => c !== "disk-full");
  fs.writeFileSync(path.join(d, "interlock.json"), JSON.stringify(p, null, 2));
  const r = il(["lint"], { cwd: d });
  eq(r.code, 1, "exit code");
  ok(r.out.includes("disk-full"), "should name the unrouted class");
});

test("lint rejects auto-clearing a class with no automatic fix", () => {
  const d = tmp();
  il(["init", "--owner", "me@example.com"], { cwd: d });
  const p = JSON.parse(fs.readFileSync(path.join(d, "interlock.json"), "utf8"));
  p.clearance.hold = p.clearance.hold.filter((c) => c !== "npm-peer-conflict");
  p.clearance.auto.push("npm-peer-conflict");
  fs.writeFileSync(path.join(d, "interlock.json"), JSON.stringify(p, null, 2));
  const r = il(["lint"], { cwd: d });
  eq(r.code, 1, "exit code");
  ok(r.out.includes("no automatic fix"), "should explain why it would stall");
});

// ------------------------------------------------------------- fingerprint

console.log("\nfingerprint");

test("the same failure in two different runs fingerprints identically", () => {
  const a = json(["diagnose", path.join(EX_OUT, "logs/run-4502.log")]);
  const b = json(["diagnose", path.join(EX_OUT, "logs/run-4530.log")]);
  ok(/^[0-9a-f]{12}$/.test(a.fingerprint), "fingerprint should be 12 hex chars");
  eq(b.fingerprint, a.fingerprint, "two runs of the same break");
});

test("a different failure fingerprints differently", () => {
  const a = json(["diagnose", path.join(EX_OUT, "logs/run-4502.log")]);
  const b = json(["diagnose", path.join(EX_MOD, "logs/run-4471.log")]);
  ok(a.fingerprint !== b.fingerprint, "different breaks must not collide");
});

test("timestamps, run ids, paths and hashes are stripped before hashing", () => {
  const d = tmp();
  const base = "ModuleNotFoundError: No module named 'requests'";
  fs.writeFileSync(path.join(d, "a.log"), `2026-01-01T00:00:00.0000000Z /home/runner/work/x/abc1234 ${base}\n`);
  fs.writeFileSync(path.join(d, "b.log"), `2026-12-31T23:59:59.9999999Z /home/runner/work/y/9f3ac1b ${base}\n`);
  const a = json(["diagnose", path.join(d, "a.log")]);
  const b = json(["diagnose", path.join(d, "b.log")]);
  eq(b.fingerprint, a.fingerprint, "volatile parts must not reach the hash");
});

// ---------------------------------------------------------------- classify

console.log("\nclassify");

const CASES = [
  ["ModuleNotFoundError: No module named 'requests'", "missing-python-module"],
  ["##[warning]The `set-output` command is deprecated", "set-output-deprecated"],
  ["npm ERR! ERESOLVE could not resolve", "npm-peer-conflict"],
  ["Error: Cannot find module 'lodash'", "node-missing-module"],
  ["ERROR: ResolutionImpossible: for help visit", "pip-resolution-conflict"],
  ["  IndentationError: unexpected indent", "python-syntax-error"],
  ["##[error]Input required and not supplied: token", "missing-secret"],
  ["The job running on runner GitHub Actions 4 has exceeded the maximum execution time of 360 minutes", "job-timeout"],
  ["FATAL ERROR: JavaScript heap out of memory", "runner-oom"],
  ["OSError: [Errno 28] No space left on device", "disk-full"],
  ["FAILED tests/test_api.py::test_create", "test-failure"],
  ["something nobody has ever seen before", "unknown"],
];

test("each failure class is recognised from a real log line", () => {
  const d = tmp();
  for (const [line, expected] of CASES) {
    const f = path.join(d, "x.log");
    fs.writeFileSync(f, line + "\n");
    const r = json(["diagnose", f]);
    eq(r.class, expected, `"${line.slice(0, 40)}..."`);
  }
});

// ------------------------------------------------------------------ patches

console.log("\npatches");

function gitApplyCheck(dir, patch) {
  const p = path.join(dir, "candidate.diff");
  fs.writeFileSync(p, patch);
  const r = spawnSync("git", ["apply", "--check", "--verbose", p], { cwd: dir, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

test("the generated requirements patch applies with git apply", () => {
  const d = tmp();
  copy(EX_MOD, d);
  spawnSync("git", ["init", "-q"], { cwd: d });
  const r = json(["diagnose", path.join(EX_MOD, "logs/run-4471.log"), "--root", d]);
  eq(r.proposal.kind, "patch", "proposal kind");
  const g = gitApplyCheck(d, r.proposal.patch);
  ok(g.ok, "git apply --check failed:\n" + g.out);
});

test("the generated workflow patch applies with git apply", () => {
  const d = tmp();
  copy(EX_OUT, d);
  spawnSync("git", ["init", "-q"], { cwd: d });
  const r = json(["diagnose", path.join(EX_OUT, "logs/run-4502.log"), "--root", d]);
  eq(r.proposal.kind, "patch", "proposal kind");
  const g = gitApplyCheck(d, r.proposal.patch);
  ok(g.ok, "git apply --check failed:\n" + g.out);
});

test("appending to a file with no trailing newline still applies", () => {
  const d = tmp();
  copy(EX_MOD, d);
  fs.writeFileSync(path.join(d, "requirements.txt"), "flask==3.0.0\ngunicorn==21.2.0");
  spawnSync("git", ["init", "-q"], { cwd: d });
  const r = json(["diagnose", path.join(EX_MOD, "logs/run-4471.log"), "--root", d]);
  const g = gitApplyCheck(d, r.proposal.patch);
  ok(g.ok, "git apply --check failed:\n" + g.out);
});

test("a dependency that is already pinned gets no patch", () => {
  const d = tmp();
  copy(EX_MOD, d);
  fs.writeFileSync(path.join(d, "requirements.txt"), "flask==3.0.0\nrequests==2.31.0\n");
  const r = json(["diagnose", path.join(EX_MOD, "logs/run-4471.log"), "--root", d]);
  eq(r.proposal.kind, "none", "proposal kind");
  ok(r.proposal.note.includes("already pinned"), "should say why");
});

test("a similarly named package does not count as already pinned", () => {
  const d = tmp();
  copy(EX_MOD, d);
  fs.writeFileSync(path.join(d, "requirements.txt"), "requests-toolbelt==1.0.0\n");
  const r = json(["diagnose", path.join(EX_MOD, "logs/run-4471.log"), "--root", d]);
  eq(r.proposal.kind, "patch", "requests-toolbelt is not requests");
});

// -------------------------------------------------------------------- gate

console.log("\ngate");

function sandbox(from) {
  const d = tmp();
  copy(from, d);
  return d;
}

test("gate exits 0 and emits a patch for a pre-cleared class", () => {
  const d = sandbox(EX_MOD);
  const r = il(["gate", path.join(EX_MOD, "logs/run-4471.log"), "--root", d, "--repo", "acme/api", "--run", "1"]);
  eq(r.code, 0, "exit code");
  ok(r.out.includes("AUTO"), "verdict");
  ok(r.out.includes("+requests"), "patch should be printed");
});

test("gate exits 75 and holds a class that needs clearance", () => {
  const d = sandbox(EX_OUT);
  const r = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "acme/api", "--run", "1"]);
  eq(r.code, 75, "exit code");
  ok(r.out.includes("HOLD"), "verdict");
  ok(/held as h-[0-9a-f]{8}/.test(r.out), "should print an id to clear");
});

test("gate exits 1 and refuses a class no agent may touch", () => {
  const d = sandbox(EX_MOD);
  fs.writeFileSync(path.join(d, "secret.log"), "##[error]Input required and not supplied: registry-token\n");
  const r = il(["gate", path.join(d, "secret.log"), "--root", d, "--repo", "acme/api", "--run", "1"]);
  eq(r.code, 1, "exit code");
  ok(r.out.includes("REFUSE"), "verdict");
});

test("scope is derived from the patch: a denied target is refused", () => {
  const d = sandbox(EX_OUT);
  fs.renameSync(
    path.join(d, ".github/workflows/build.yml"),
    path.join(d, ".github/workflows/release.yml")
  );
  const r = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "acme/api", "--run", "1"]);
  eq(r.code, 1, "exit code");
  ok(r.out.includes("denied by scope.deny"), "should name the rule that stopped it");
});

test("a patch over the line limit is held, not auto-cleared", () => {
  const d = sandbox(EX_MOD);
  const p = JSON.parse(fs.readFileSync(path.join(d, "interlock.json"), "utf8"));
  p.limits.max_lines_changed = 0.5;
  fs.writeFileSync(path.join(d, "interlock.json"), JSON.stringify(p, null, 2));
  const r = il(["gate", path.join(EX_MOD, "logs/run-4471.log"), "--root", d, "--repo", "acme/api", "--run", "1"]);
  eq(r.code, 75, "exit code");
  ok(r.out.includes("limit is 0.5"), "should name the limit");
});

// ---------------------------------------------------------------- warrants

console.log("\nwarrants");

function holdIdFrom(out) {
  const m = out.match(/held as (h-[0-9a-f]{8})/);
  if (!m) throw new Error("no hold id in output:\n" + out);
  return m[1];
}

test("a cleared failure auto-clears the next time it happens", () => {
  const d = sandbox(EX_OUT);
  const first = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  const id = holdIdFrom(first.out);
  const cleared = il(["clear", id, "--root", d, "--by", "Test Person"]);
  eq(cleared.code, 0, "clear exit code");

  const second = il(["gate", path.join(EX_OUT, "logs/run-4530.log"), "--root", d, "--repo", "a/b", "--run", "2"]);
  eq(second.code, 0, "the same failure should not stop again");
  ok(second.out.includes("warrant " + id), "should cite the warrant");
  ok(second.out.includes("Test Person"), "should name who cleared it");
});

test("a rejected failure stops again", () => {
  const d = sandbox(EX_OUT);
  const first = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  const id = holdIdFrom(first.out);
  eq(il(["reject", id, "--root", d, "--by", "Test Person"]).code, 0, "reject exit code");
  const second = il(["gate", path.join(EX_OUT, "logs/run-4530.log"), "--root", d, "--repo", "a/b", "--run", "2"]);
  eq(second.code, 75, "a rejection must not become an approval");
});

test("changing the rules voids past clearances", () => {
  const d = sandbox(EX_OUT);
  const first = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  il(["clear", holdIdFrom(first.out), "--root", d, "--by", "Test Person"]);

  const p = JSON.parse(fs.readFileSync(path.join(d, "interlock.json"), "utf8"));
  p.scope.allow.push("Dockerfile");
  fs.writeFileSync(path.join(d, "interlock.json"), JSON.stringify(p, null, 2));

  const second = il(["gate", path.join(EX_OUT, "logs/run-4530.log"), "--root", d, "--repo", "a/b", "--run", "2"]);
  eq(second.code, 75, "a loosened policy must send it back to a person");
});

test("an expired warrant sends the failure back to a person", () => {
  const d = sandbox(EX_OUT);
  const first = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"], {
    env: { INTERLOCK_NOW: "2026-01-01T00:00:00.000Z" },
  });
  il(["clear", holdIdFrom(first.out), "--root", d, "--by", "Test Person"], {
    env: { INTERLOCK_NOW: "2026-01-01T00:00:00.000Z" },
  });
  const late = il(["gate", path.join(EX_OUT, "logs/run-4530.log"), "--root", d, "--repo", "a/b", "--run", "2"], {
    env: { INTERLOCK_NOW: "2026-03-01T00:00:00.000Z" },
  });
  eq(late.code, 75, "59 days later, a 14-day warrant is gone");
  ok(late.out.includes("expired"), "should say why");
});

test("a warrant runs out after max_uses", () => {
  const d = sandbox(EX_OUT);
  const p = JSON.parse(fs.readFileSync(path.join(d, "interlock.json"), "utf8"));
  p.warrant.max_uses = 2;
  fs.writeFileSync(path.join(d, "interlock.json"), JSON.stringify(p, null, 2));

  const first = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  il(["clear", holdIdFrom(first.out), "--root", d, "--by", "Test Person"]);
  for (const run of ["2", "3"])
    eq(
      il(["gate", path.join(EX_OUT, "logs/run-4530.log"), "--root", d, "--repo", "a/b", "--run", run]).code,
      0,
      `use ${run} should be covered`
    );
  const fourth = il(["gate", path.join(EX_OUT, "logs/run-4530.log"), "--root", d, "--repo", "a/b", "--run", "4"]);
  eq(fourth.code, 75, "the third use is past the limit");
});

test("clearing requires a name", () => {
  const d = sandbox(EX_OUT);
  const first = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  const r = il(["clear", holdIdFrom(first.out), "--root", d], {
    env: { INTERLOCK_BY: "", USER: "", USERNAME: "" },
  });
  eq(r.code, 1, "unsigned clearances are not clearances");
});

test("a hold cannot be resolved twice", () => {
  const d = sandbox(EX_OUT);
  const first = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  const id = holdIdFrom(first.out);
  il(["clear", id, "--root", d, "--by", "Test Person"]);
  const again = il(["reject", id, "--root", d, "--by", "Someone Else"]);
  eq(again.code, 1, "already resolved");
});

// ------------------------------------------------------------------- modes

console.log("\nmodes");

function withMode(dir, mode) {
  const p = JSON.parse(fs.readFileSync(path.join(dir, "interlock.json"), "utf8"));
  p.mode = mode;
  fs.writeFileSync(path.join(dir, "interlock.json"), JSON.stringify(p, null, 2));
}

test("shadow records the verdict, blocks nothing, emits no patch", () => {
  const d = sandbox(EX_MOD);
  withMode(d, "shadow");
  const r = il(["gate", path.join(EX_MOD, "logs/run-4471.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  eq(r.code, 0, "shadow never blocks");
  ok(!r.out.includes("+requests"), "shadow must not emit a patch");
  ok(fs.existsSync(path.join(d, ".interlock/ledger.jsonl")), "but it must still record");
});

test("strict sends every patch to a person", () => {
  const d = sandbox(EX_MOD);
  withMode(d, "strict");
  const r = il(["gate", path.join(EX_MOD, "logs/run-4471.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  eq(r.code, 75, "exit code");
  ok(r.out.includes("strict mode"), "should say why");
});

test("strict ignores warrants", () => {
  const d = sandbox(EX_OUT);
  const first = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  il(["clear", holdIdFrom(first.out), "--root", d, "--by", "Test Person"]);
  withMode(d, "strict");
  const second = il(["gate", path.join(EX_OUT, "logs/run-4530.log"), "--root", d, "--repo", "a/b", "--run", "2"]);
  eq(second.code, 75, "strict means strict");
});

test("off passes everything through and records nothing", () => {
  const d = sandbox(EX_MOD);
  withMode(d, "off");
  const r = il(["gate", path.join(EX_MOD, "logs/run-4471.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  eq(r.code, 0, "exit code");
  ok(!fs.existsSync(path.join(d, ".interlock/ledger.jsonl")), "off writes no ledger");
});

// ------------------------------------------------------------------ record

console.log("\nrecord");

test("every ledger line is valid JSON with the required fields", () => {
  const d = sandbox(EX_OUT);
  const first = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  il(["clear", holdIdFrom(first.out), "--root", d, "--by", "Test Person"]);
  il(["gate", path.join(EX_OUT, "logs/run-4530.log"), "--root", d, "--repo", "a/b", "--run", "2"]);

  const lines = fs
    .readFileSync(path.join(d, ".interlock/ledger.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  ok(lines.length === 3, `expected 3 entries, got ${lines.length}`);
  lines.forEach((l, i) => {
    const e = JSON.parse(l);
    eq(e.seq, i + 1, "seq should be dense");
    for (const k of ["ts", "event", "id", "fingerprint", "class", "rules", "mode"])
      ok(e[k] !== undefined, `entry ${i + 1} is missing ${k}`);
    ok(/^[0-9a-f]{12}$/.test(e.rules), "rules hash shape");
  });
  eq(JSON.parse(lines[1]).by, "Test Person", "a clearance records who signed it");
});

test("log --verify reports policy drift and open holds", () => {
  const d = sandbox(EX_OUT);
  il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  const clean = il(["log", "--verify", "--root", d]);
  ok(clean.out.includes("1 still waiting on a person"), "open hold count:\n" + clean.out);

  const p = JSON.parse(fs.readFileSync(path.join(d, "interlock.json"), "utf8"));
  p.limits.max_files_changed = 9;
  fs.writeFileSync(path.join(d, "interlock.json"), JSON.stringify(p, null, 2));
  const drifted = il(["log", "--verify", "--root", d]);
  ok(drifted.out.includes("1 recorded under rules that no longer apply"), "drift:\n" + drifted.out);
});

test("a truncated ledger is reported, not silently ignored", () => {
  const d = sandbox(EX_OUT);
  il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1"]);
  const lp = path.join(d, ".interlock/ledger.jsonl");
  fs.appendFileSync(lp, '{"seq":2,"ts":"broken\n');
  const r = il(["log", "--root", d]);
  eq(r.code, 1, "exit code");
  ok(r.out.includes("truncated or hand-edited"), "should say what is wrong");
});

// ------------------------------------------------------------------ slack

console.log("\nslack");

test("the slack payload carries the patch and the two buttons", () => {
  const d = sandbox(EX_OUT);
  const r = il(["gate", path.join(EX_OUT, "logs/run-4502.log"), "--root", d, "--repo", "a/b", "--run", "1", "--slack"]);
  const payload = JSON.parse(r.out);
  ok(payload.text.includes("hold"), "summary text");
  const kinds = payload.blocks.map((b) => b.type);
  ok(kinds.includes("actions"), "a held decision needs buttons");
  const buttons = payload.blocks.find((b) => b.type === "actions").elements;
  eq(buttons.length, 2, "clear and reject");
  ok(buttons[0].value.startsWith("interlock clear h-"), "clear button carries the id");
});

test("an auto verdict gets no buttons", () => {
  const d = sandbox(EX_MOD);
  const r = il(["gate", path.join(EX_MOD, "logs/run-4471.log"), "--root", d, "--repo", "a/b", "--run", "1", "--slack"]);
  const payload = JSON.parse(r.out);
  ok(!payload.blocks.some((b) => b.type === "actions"), "nothing to approve");
});

// ------------------------------------------------------------------- done

console.log("");
if (failures.length) {
  console.log(`${pass} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`${pass} passed\n`);

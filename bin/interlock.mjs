#!/usr/bin/env node
// interlock — the human interlock for self-healing CI.
// Zero dependencies. Node built-ins only.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const VERSION = "1.0.0";
const POLICY_FILE = "interlock.json";
const STATE_DIR = ".interlock";

// ---------------------------------------------------------------- output

const ESC = "[";
const ANSI = /\[[0-9;]*m/g;
const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY;
const paint = (code, s) => (useColor ? `${ESC}${code}m${s}${ESC}0m` : s);
const visible = (s) => s.replace(ANSI, "");
const padVisible = (s, n) => s + " ".repeat(Math.max(1, n - visible(s).length));

const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);
const red = (s) => paint("31", s);
const cyan = (s) => paint("36", s);

const say = (s = "") => process.stdout.write(s + "\n");
function die(msg, code = 1) {
  process.stderr.write(red("error: ") + msg + "\n");
  process.exit(code);
}

// ---------------------------------------------------------------- helpers

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = () => process.env.INTERLOCK_NOW || new Date().toISOString();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJson(p) {
  const raw = readText(p);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${p} is not valid JSON — ${e.message}`);
  }
}

// Minimal glob: ** crosses directories, * does not, ? is one character.
function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += escapeRe(ch);
  }
  return new RegExp("^" + re + "$");
}

const matchesAny = (file, globs) =>
  (globs || []).some((g) => globToRe(g).test(file.replace(/\\/g, "/")));

// ---------------------------------------------------------------- normalise

// Strip everything that changes between two runs of the same failure, so the
// same break always produces the same fingerprint.
function normalize(text) {
  return text
    .replace(ANSI, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/gm, "")
    .replace(/^##\[(group|endgroup|debug|command)\].*$/gm, "")
    .replace(/[A-Za-z]:\\[^\s"']+|\/(?:home|Users|opt|tmp|github|runner)\/[^\s"':]+/g, "<path>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hex>")
    .replace(/\b\d{5,}\b/g, "<n>")
    .replace(/\bline \d+\b/g, "line <n>")
    .replace(/:\d+:\d+\b/g, ":<n>:<n>")
    .replace(/\b\d+m\s?\d+(\.\d+)?s\b/g, "<dur>")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- classify

// Ordered most-specific first. `pick` pulls out the detail a fix would need.
const CLASSES = [
  {
    id: "missing-python-module",
    label: "A Python import is not in the dependency file",
    match: /ModuleNotFoundError: No module named ['"]([\w.\-]+)['"]/,
    pick: (m) => ({ module: m[1].split(".")[0] }),
  },
  {
    id: "set-output-deprecated",
    label: "Workflow uses the removed set-output / save-state commands",
    match: /The `?(set-output|save-state)`? command is deprecated/i,
    pick: (m) => ({ command: m[1] }),
  },
  {
    id: "lockfile-drift",
    label: "Lockfile and manifest disagree",
    match: /(can only install packages when your package\.json and package-lock\.json|lock file(?:'s)? .{0,40}does not satisfy|Your lockfile needs to be updated)/i,
    pick: () => ({}),
  },
  {
    id: "npm-peer-conflict",
    label: "npm cannot resolve a peer dependency",
    match: /ERESOLVE (?:could not resolve|unable to resolve dependency tree)/i,
    pick: () => ({}),
  },
  {
    id: "pip-resolution-conflict",
    label: "pip cannot find a version set that satisfies every pin",
    match: /(ResolutionImpossible|because these package versions have conflicting dependencies)/i,
    pick: () => ({}),
  },
  {
    id: "node-missing-module",
    label: "A Node import is not installed",
    match: /Cannot find module ['"]([^'"]+)['"]/,
    pick: (m) => ({ module: m[1] }),
  },
  {
    id: "deprecated-action-version",
    label: "A pinned action version is deprecated",
    match: /(Node\.js 1[268] actions are deprecated|This action is deprecated|is scheduled for deprecation)/i,
    pick: () => ({}),
  },
  {
    id: "python-syntax-error",
    label: "The code does not parse",
    match: /^\s*(IndentationError|SyntaxError|TabError): (.+)$/m,
    pick: (m) => ({ kind: m[1], detail: m[2] }),
  },
  {
    id: "missing-secret",
    label: "A secret or required input is empty",
    match: /(Input required and not supplied: (\S+)|(?:Secret|Environment variable) \S+ is (?:not set|required|empty))/i,
    pick: (m) => ({ input: m[2] || "" }),
  },
  {
    id: "job-timeout",
    label: "The job ran past its time limit",
    match: /has exceeded the maximum execution time/i,
    pick: () => ({}),
  },
  {
    id: "runner-oom",
    label: "The runner ran out of memory",
    match: /(JavaScript heap out of memory|exit code 137|Out of memory: Killed process)/i,
    pick: () => ({}),
  },
  {
    id: "disk-full",
    label: "The runner ran out of disk",
    match: /No space left on device/i,
    pick: () => ({}),
  },
  {
    id: "test-failure",
    label: "A test failed — the pipeline works, the code does not",
    match: /(^FAILED \S+|=+ \d+ failed[,\s]|Tests:\s+\d+ failed|FAIL\s+\S+\.(test|spec)\.)/m,
    pick: () => ({}),
  },
];

const CLASS_IDS = [...CLASSES.map((c) => c.id), "unknown"];

// Only these three have a deterministic fix. Everything else needs a person
// (or an LLM behind a person). Kept static so `lint` never depends on cwd.
const AUTOFIXABLE = new Set(["missing-python-module", "set-output-deprecated", "lockfile-drift"]);

function classify(rawLog) {
  const text = normalize(rawLog);
  for (const c of CLASSES) {
    const m = text.match(c.match);
    if (m) {
      return {
        class: c.id,
        label: c.label,
        evidence: m[0].trim().slice(0, 300),
        detail: c.pick(m),
      };
    }
  }
  // Nothing matched: keep the last non-empty line as the best guess at what broke.
  const lines = text.split("\n").filter((l) => l.trim());
  return {
    class: "unknown",
    label: "No rule matched — hand this to a human or an LLM",
    evidence: (lines[lines.length - 1] || "").slice(0, 300),
    detail: {},
  };
}

const fingerprint = (r) => sha(`${r.class}|${normalize(r.evidence)}`).slice(0, 12);

// ---------------------------------------------------------------- patches

function unifiedAppend(rel, abs, line) {
  const orig = readText(abs) ?? "";
  const endsNl = orig === "" || orig.endsWith("\n");
  const lines = orig === "" ? [] : orig.replace(/\n$/, "").split("\n");
  const start = Math.max(1, lines.length - 2);
  const ctx = lines.slice(start - 1);
  const head = [`--- a/${rel}`, `+++ b/${rel}`];

  if (endsNl) {
    const n = ctx.length;
    return [
      ...head,
      `@@ -${lines.length ? start : 0},${n} +${lines.length ? start : 1},${n + 1} @@`,
      ...ctx.map((l) => " " + l),
      "+" + line,
      "",
    ].join("\n");
  }
  // No trailing newline, so the last line itself changes.
  const keep = ctx.slice(0, -1);
  const last = ctx[ctx.length - 1];
  return [
    ...head,
    `@@ -${start},${ctx.length} +${start},${ctx.length + 1} @@`,
    ...keep.map((l) => " " + l),
    "-" + last,
    "\\ No newline at end of file",
    "+" + last,
    "+" + line,
    "",
  ].join("\n");
}

// Diff for in-place line rewrites (line count unchanged), grouped into hunks.
function unifiedReplace(rel, oldLines, newLines) {
  const changed = [];
  for (let i = 0; i < oldLines.length; i++)
    if (oldLines[i] !== newLines[i]) changed.push(i);
  if (!changed.length) return null;

  const blocks = [];
  for (const i of changed) {
    const last = blocks[blocks.length - 1];
    if (last && i - last[last.length - 1] <= 6) last.push(i);
    else blocks.push([i]);
  }

  const out = [`--- a/${rel}`, `+++ b/${rel}`];
  for (const b of blocks) {
    const from = Math.max(0, b[0] - 3);
    const to = Math.min(oldLines.length - 1, b[b.length - 1] + 3);
    const body = [];
    let i = from;
    while (i <= to) {
      if (oldLines[i] === newLines[i]) {
        body.push(" " + oldLines[i]);
        i++;
        continue;
      }
      let j = i; // group a run of changes as removals then additions, like diff does
      while (j <= to && oldLines[j] !== newLines[j]) j++;
      for (let k = i; k < j; k++) body.push("-" + oldLines[k]);
      for (let k = i; k < j; k++) body.push("+" + newLines[k]);
      i = j;
    }
    const count = to - from + 1;
    out.push(`@@ -${from + 1},${count} +${from + 1},${count} @@`, ...body);
  }
  out.push("");
  return out.join("\n");
}

function findWorkflows(root) {
  const dir = path.join(root, ".github", "workflows");
  try {
    return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => ".github/workflows/" + f);
  } catch {
    return [];
  }
}

const REROUTE = {
  "node-missing-module": 'pick a version for "%s" and add it to package.json — version choice is a judgement call',
  "deprecated-action-version": "bump the action to a version you have checked — this tool will not guess a version number",
  "npm-peer-conflict": "resolve the peer range by hand, or decide to override it",
  "pip-resolution-conflict": "loosen one pin — which one is a product decision",
  "python-syntax-error": "fix the source; a syntax error is a code bug, not a pipeline bug",
  "missing-secret": "add the secret in repository settings — an agent must never write secrets",
  "job-timeout": "raise the timeout or split the job",
  "runner-oom": "use a larger runner or lower concurrency",
  "disk-full": "free space or use a larger runner",
  "test-failure": "the pipeline is fine; a test caught something",
  unknown: "no rule matched — this is the payload to hand an LLM",
};

// What a fix would touch, and what it would do. kind is patch | command | none.
function propose(res, root) {
  const none = (note) => ({ kind: "none", files: [], patch: null, command: null, note });

  if (res.class === "missing-python-module") {
    const mod = res.detail.module;
    const candidates = ["requirements.txt", "requirements/base.txt", "requirements-dev.txt"];
    const rel = candidates.find((f) => fs.existsSync(path.join(root, f)));
    if (!rel) return none(`add "${mod}" to your Python dependency file (none found in this checkout)`);
    const already = new RegExp(`^${escapeRe(mod)}\\s*($|[=<>!~;[])`, "im");
    if (already.test(readText(path.join(root, rel)) ?? ""))
      return none(`"${mod}" is already pinned in ${rel} — the install step is the problem, not the pin`);
    return {
      kind: "patch",
      files: [rel],
      patch: unifiedAppend(rel, path.join(root, rel), mod),
      command: null,
      note: `add "${mod}" to ${rel}`,
    };
  }

  if (res.class === "set-output-deprecated") {
    const patches = [];
    for (const rel of findWorkflows(root)) {
      const src = readText(path.join(root, rel));
      if (!src || !/::(set-output|save-state)\s+name=/.test(src)) continue;
      const oldLines = src.replace(/\n$/, "").split("\n");
      const newLines = oldLines.map((l) =>
        l
          .replace(/(["'])::set-output\s+name=([^:]+)::([\s\S]*?)\1/g,
            (_m, q, k, v) => `${q}${k.trim()}=${v}${q} >> "$GITHUB_OUTPUT"`)
          .replace(/(["'])::save-state\s+name=([^:]+)::([\s\S]*?)\1/g,
            (_m, q, k, v) => `${q}${k.trim()}=${v}${q} >> "$GITHUB_STATE"`)
      );
      const d = unifiedReplace(rel, oldLines, newLines);
      if (d) patches.push({ rel, d });
    }
    if (!patches.length) return none("no workflow file in this checkout still writes set-output");
    return {
      kind: "patch",
      files: patches.map((p) => p.rel),
      patch: patches.map((p) => p.d).join(""),
      command: null,
      note: "rewrite set-output / save-state as $GITHUB_OUTPUT / $GITHUB_STATE writes",
    };
  }

  if (res.class === "lockfile-drift")
    return {
      kind: "command",
      files: ["package-lock.json"],
      patch: null,
      command: "npm install --package-lock-only",
      note: "regenerate the lockfile from package.json",
    };

  if (res.class === "node-missing-module")
    return none(REROUTE["node-missing-module"].replace("%s", res.detail.module));
  return none(REROUTE[res.class] || "no automatic fix for this class");
}

// ---------------------------------------------------------------- policy

const DEFAULT_POLICY = {
  $schema: "https://raw.githubusercontent.com/manpreet171/interlock/main/schema/policy.schema.json",
  version: 1,
  owner: "you@example.com",
  mode: "normal",
  scope: {
    allow: [
      "requirements*.txt",
      "requirements/*.txt",
      "package.json",
      "package-lock.json",
      ".github/workflows/*.yml",
    ],
    deny: ["**/*deploy*", "**/*release*", "infra/**", "terraform/**", "**/*secret*", "**/*.pem", "**/*.key"],
  },
  clearance: {
    auto: ["missing-python-module"],
    hold: [
      "set-output-deprecated",
      "lockfile-drift",
      "node-missing-module",
      "npm-peer-conflict",
      "pip-resolution-conflict",
      "deprecated-action-version",
      "unknown",
    ],
    refuse: ["missing-secret", "job-timeout", "runner-oom", "disk-full", "test-failure", "python-syntax-error"],
  },
  warrant: { reuse: true, expires_after_days: 14, max_uses: 5 },
  limits: { max_files_changed: 2, max_lines_changed: 20 },
  record: { path: ".interlock/ledger.jsonl" },
};

const MODES = ["off", "shadow", "normal", "strict"];

// Hash only the enforcing parts. Change these and past clearances die; change
// the owner or the $schema line and they survive.
function ruleHash(p) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object")
      return Object.keys(v).sort().reduce((o, k) => ((o[k] = canon(v[k])), o), {});
    return v;
  };
  return sha(
    JSON.stringify(canon({ scope: p.scope, clearance: p.clearance, warrant: p.warrant, limits: p.limits, mode: p.mode }))
  ).slice(0, 12);
}

function lintPolicy(p) {
  const e = [];
  if (p.version !== 1) e.push(`version must be 1 (got ${JSON.stringify(p.version)})`);
  if (!p.owner || p.owner === "you@example.com")
    e.push("owner is still the placeholder — put a real person or team there");
  if (!MODES.includes(p.mode)) e.push(`mode must be one of ${MODES.join(" | ")} (got ${JSON.stringify(p.mode)})`);

  for (const key of ["allow", "deny"])
    if (!Array.isArray(p.scope?.[key])) e.push(`scope.${key} must be an array of globs`);
  if (Array.isArray(p.scope?.allow) && p.scope.allow.length === 0)
    e.push("scope.allow is empty — nothing could ever be patched");

  const seen = new Map();
  for (const bucket of ["auto", "hold", "refuse"]) {
    const list = p.clearance?.[bucket];
    if (!Array.isArray(list)) {
      e.push(`clearance.${bucket} must be an array`);
      continue;
    }
    for (const id of list) {
      if (!CLASS_IDS.includes(id)) e.push(`clearance.${bucket} lists unknown class "${id}"`);
      if (seen.has(id)) e.push(`class "${id}" is in both clearance.${seen.get(id)} and clearance.${bucket}`);
      seen.set(id, bucket);
    }
  }
  for (const id of CLASS_IDS)
    if (!seen.has(id)) e.push(`class "${id}" is not routed — put it in auto, hold or refuse`);
  for (const id of p.clearance?.auto || [])
    if (CLASS_IDS.includes(id) && !AUTOFIXABLE.has(id))
      e.push(`clearance.auto lists "${id}" but no automatic fix exists for it — it would stall on every run`);

  if (typeof p.warrant?.expires_after_days !== "number" || p.warrant.expires_after_days <= 0)
    e.push("warrant.expires_after_days must be a positive number");
  if (typeof p.warrant?.max_uses !== "number" || p.warrant.max_uses <= 0)
    e.push("warrant.max_uses must be a positive number");
  if (p.warrant?.reuse === true && p.warrant?.expires_after_days > 90)
    e.push("warrant.expires_after_days over 90 with reuse on is a standing approval with no end");
  for (const k of ["max_files_changed", "max_lines_changed"])
    if (typeof p.limits?.[k] !== "number" || p.limits[k] <= 0) e.push(`limits.${k} must be a positive number`);
  if (!p.record?.path) e.push("record.path is required — a decision nobody can read is not a decision");
  return e;
}

function loadPolicy(root) {
  const p = readJson(path.join(root, POLICY_FILE));
  if (!p) die(`no ${POLICY_FILE} here. Run: interlock init`);
  return p;
}

// ---------------------------------------------------------------- decide

function decide(policy, res, proposal) {
  const cls = res.class;
  const bucket = (policy.clearance.refuse || []).includes(cls)
    ? "refuse"
    : (policy.clearance.auto || []).includes(cls)
      ? "auto"
      : "hold";

  if (policy.mode === "off") return { verdict: "pass", reason: "mode is off" };
  if (bucket === "refuse")
    return { verdict: "refuse", reason: `class "${cls}" is on the refuse list — no agent may patch this` };

  // Scope is derived from the proposed change, not declared by the agent.
  for (const f of proposal.files) {
    if (matchesAny(f, policy.scope.deny)) return { verdict: "refuse", reason: `${f} is denied by scope.deny` };
    if (!matchesAny(f, policy.scope.allow)) return { verdict: "refuse", reason: `${f} is outside scope.allow` };
  }

  if (proposal.kind === "none")
    return { verdict: "hold", reason: "no automatic fix — a person has to write this one" };
  if (proposal.files.length > policy.limits.max_files_changed)
    return { verdict: "hold", reason: `touches ${proposal.files.length} files, limit is ${policy.limits.max_files_changed}` };

  const changed = (proposal.patch || "").split("\n").filter((l) => /^[+-][^+-]/.test(l)).length;
  if (changed > policy.limits.max_lines_changed)
    return { verdict: "hold", reason: `changes ${changed} lines, limit is ${policy.limits.max_lines_changed}` };

  if (policy.mode === "strict" && bucket === "auto")
    return { verdict: "hold", reason: "strict mode — every patch gets a person" };
  if (bucket === "auto")
    return { verdict: "auto", reason: `class "${cls}" is pre-cleared and the change is in scope` };
  return { verdict: "hold", reason: `class "${cls}" needs clearance` };
}

// ---------------------------------------------------------------- ledger

const ledgerPath = (root, policy) => path.join(root, policy.record?.path || `${STATE_DIR}/ledger.jsonl`);

function readLedger(root, policy) {
  const raw = readText(ledgerPath(root, policy));
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        die(`ledger line ${i + 1} is not valid JSON — the record has been truncated or hand-edited`);
      }
    });
}

function appendLedger(root, policy, entry) {
  const p = ledgerPath(root, policy);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const seq = readLedger(root, policy).length + 1;
  const full = { seq, ts: now(), ...entry };
  fs.appendFileSync(p, JSON.stringify(full) + "\n", "utf8");
  return full;
}

// A warrant is a past clearance for THIS failure under THESE rules.
function liveWarrant(entries, fp, rules, policy, at) {
  if (!policy.warrant.reuse || policy.mode === "strict") return null;
  const cleared = entries.filter((e) => e.event === "cleared" && e.fingerprint === fp && e.rules === rules);
  if (!cleared.length) return null;
  const w = cleared[cleared.length - 1];
  const uses = entries.filter((e) => e.event === "reuse" && e.warrant === w.id).length;
  const ageDays = (Date.parse(at) - Date.parse(w.ts)) / 86400000;
  if (ageDays > policy.warrant.expires_after_days)
    return { expired: true, reason: `warrant ${w.id} expired — cleared ${Math.floor(ageDays)} days ago, limit is ${policy.warrant.expires_after_days}` };
  if (uses + 1 > policy.warrant.max_uses)
    return { expired: true, reason: `warrant ${w.id} has spent all ${policy.warrant.max_uses} of its uses` };
  return { warrant: w, uses: uses + 1 };
}

const holdId = (fp, repo, run) => "h-" + sha(`${fp}:${repo}:${run}`).slice(0, 8);

// ---------------------------------------------------------------- commands

const VALUED = new Set(["repo", "run", "by", "reason", "root", "owner"]);

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split("=");
    if (v !== undefined) out[k] = v;
    else if (VALUED.has(k) && argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

function cmdInit(root, f) {
  const target = path.join(root, POLICY_FILE);
  if (fs.existsSync(target) && !f.force) die(`${POLICY_FILE} already exists (use --force to overwrite)`);
  const p = structuredClone(DEFAULT_POLICY);
  if (typeof f.owner === "string") p.owner = f.owner;
  fs.writeFileSync(target, JSON.stringify(p, null, 2) + "\n", "utf8");
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  say(green("✔ ") + `wrote ${POLICY_FILE}` + dim("   ← review this in a PR like any other code"));
  say(green("✔ ") + `created ${STATE_DIR}/` + dim("      ← the ledger lands here. Commit it."));
  say("");
  say("Next:");
  say(dim("  1. ") + 'set "owner" to a real person, then run ' + cyan("interlock lint"));
  say(dim("  2. ") + "grab a build that broke:  " + cyan("gh run view <id> --log-failed > run.log"));
  say(dim("  3. ") + "see what it makes of it:  " + cyan("interlock diagnose run.log"));
  say(dim("  4. ") + "run a week in " + bold("shadow") + " mode before you trust it.");
}

function cmdLint(root, f) {
  const file = typeof f._[0] === "string" ? f._[0] : POLICY_FILE;
  const abs = f._[0] ? path.resolve(process.cwd(), file) : path.join(root, file);
  const p = readJson(abs);
  if (!p) die(`no ${file} here. Run: interlock init`);
  const errs = lintPolicy(p);
  if (errs.length) {
    say(red(`✘ ${file} — ${errs.length} problem${errs.length > 1 ? "s" : ""}`));
    for (const e of errs) say("  " + red("•") + " " + e);
    process.exit(1);
  }
  const counts = ["auto", "hold", "refuse"].map((b) => `${p.clearance[b].length} ${b}`).join(" · ");
  say(green(`✔ ${file} is valid`));
  say(dim(`  mode ${p.mode} · ${counts} · rules ${ruleHash(p)}`));
}

function report(res, fp, proposal, verdict) {
  const tone = { auto: green, hold: yellow, refuse: red, pass: dim }[verdict.verdict];
  say(bold(res.class) + dim(`  ${fp}`));
  say(dim("  " + res.label));
  say(dim("  evidence  ") + res.evidence.split("\n")[0]);
  say(dim("  proposal  ") + (proposal.kind === "none" ? dim("none — " + proposal.note) : proposal.note));
  if (proposal.files.length) say(dim("  touches   ") + proposal.files.join(", "));
  say("");
  say(tone("  " + verdict.verdict.toUpperCase()) + "  " + verdict.reason);
}

function slackPayload(res, fp, proposal, verdict, id, repo, run) {
  const lines = [
    `*${verdict.verdict.toUpperCase()}* \`${res.class}\` — ${repo} run ${run}`,
    res.label,
    `*Fingerprint* \`${fp}\``,
    `*Proposal* ${proposal.note}`,
    proposal.files.length ? `*Touches* ${proposal.files.map((x) => "`" + x + "`").join(", ")}` : null,
    `*Why* ${verdict.reason}`,
  ].filter(Boolean);
  return {
    text: `interlock: ${verdict.verdict} ${res.class} (${fp})`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      ...(proposal.patch
        ? [{ type: "section", text: { type: "mrkdwn", text: "```\n" + proposal.patch.slice(0, 2500) + "\n```" } }]
        : []),
      ...(verdict.verdict === "hold"
        ? [
            {
              type: "actions",
              elements: [
                { type: "button", style: "primary", text: { type: "plain_text", text: "Clear" }, value: `interlock clear ${id}` },
                { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, value: `interlock reject ${id}` },
              ],
            },
          ]
        : []),
    ],
  };
}

function analyse(root, f) {
  const logFile = f._[0];
  if (!logFile) die("give me a log file, e.g. interlock gate run.log");
  // The log is just a file on disk; --root is the checkout being patched.
  const log = readText(path.resolve(process.cwd(), String(logFile)));
  if (log === null) die(`cannot read ${logFile}`);
  const res = classify(log);
  return { res, fp: fingerprint(res), proposal: propose(res, root) };
}

function cmdDiagnose(root, f) {
  const { res, fp, proposal } = analyse(root, f);
  if (f.json) return say(JSON.stringify({ ...res, fingerprint: fp, proposal }, null, 2));
  report(res, fp, proposal, { verdict: "pass", reason: "diagnose only — no policy applied" });
  if (proposal.patch && f.patch) {
    say("");
    process.stdout.write(proposal.patch);
  }
}

function cmdGate(root, f) {
  const policy = loadPolicy(root);
  if (lintPolicy(policy).length) die(`${POLICY_FILE} is invalid — run "interlock lint" and fix it first`);

  const { res, fp, proposal } = analyse(root, f);
  const repo = String(f.repo || process.env.GITHUB_REPOSITORY || "local");
  const run = String(f.run || process.env.GITHUB_RUN_ID || "0");
  const rules = ruleHash(policy);
  const id = holdId(fp, repo, run);
  let verdict = decide(policy, res, proposal);

  // A live warrant from a past clearance turns a hold back into an auto.
  let reused = null;
  if (verdict.verdict === "hold" && proposal.kind !== "none") {
    const w = liveWarrant(readLedger(root, policy), fp, rules, policy, now());
    if (w && !w.expired) {
      reused = w;
      verdict = {
        verdict: "auto",
        reason: `warrant ${w.warrant.id} — this exact failure was cleared by ${w.warrant.by} (use ${w.uses}/${policy.warrant.max_uses})`,
      };
    } else if (w?.expired) verdict = { verdict: "hold", reason: w.reason };
  }

  const shadow = policy.mode === "shadow";
  const base = {
    id,
    fingerprint: fp,
    class: res.class,
    repo,
    run,
    verdict: verdict.verdict,
    reason: verdict.reason,
    files: proposal.files,
    proposal: { kind: proposal.kind, note: proposal.note, patch: proposal.patch, command: proposal.command },
    rules,
    mode: policy.mode,
  };

  if (policy.mode !== "off") {
    if (shadow) appendLedger(root, policy, { event: "observed", ...base });
    else if (reused) appendLedger(root, policy, { event: "reuse", warrant: reused.warrant.id, ...base });
    else appendLedger(root, policy, { event: verdict.verdict, ...base });
  }

  if (f.slack) return say(JSON.stringify(slackPayload(res, fp, proposal, verdict, id, repo, run), null, 2));
  if (f.json) return say(JSON.stringify({ ...base, evidence: res.evidence, shadow }, null, 2));

  report(res, fp, proposal, verdict);
  if (shadow) return say(dim("  shadow mode — recorded, nothing blocked, no patch emitted"));
  if (verdict.verdict === "hold") {
    say("");
    say(dim("  held as ") + bold(id) + dim("  →  ") + cyan(`interlock clear ${id}`) + dim("   or   ") + cyan(`interlock reject ${id}`));
    process.exit(75);
  }
  if (verdict.verdict === "refuse") process.exit(1);
  if (proposal.patch) {
    say("");
    process.stdout.write(proposal.patch);
  } else if (proposal.command) {
    say("");
    say("  run: " + cyan(proposal.command));
  }
}

function resolveHold(root, f, event) {
  const policy = loadPolicy(root);
  const id = f._[0];
  if (!id) die(`which one? interlock ${event === "cleared" ? "clear" : "reject"} <id>`);
  const entries = readLedger(root, policy);
  const held = [...entries].reverse().find((e) => e.id === id && e.event === "hold");
  if (!held) die(`no held decision with id ${id} — run "interlock log" to see what is waiting`);
  if (entries.some((e) => e.of === id)) die(`${id} was already resolved`);

  const by = String(f.by || process.env.INTERLOCK_BY || process.env.USER || process.env.USERNAME || "");
  if (!by) die('say who is signing this off:  --by "Your Name"');

  appendLedger(root, policy, {
    event,
    of: id,
    id,
    fingerprint: held.fingerprint,
    class: held.class,
    repo: held.repo,
    run: held.run,
    by,
    reason: String(f.reason || (event === "cleared" ? "approved" : "rejected")),
    files: held.files,
    proposal: held.proposal,
    rules: held.rules,
    mode: policy.mode,
  });

  if (event === "rejected") {
    say(red("✘ rejected ") + id + dim(`  by ${by}`));
    return say(dim("  nothing was emitted. The same failure will stop here again."));
  }
  say(green("✔ cleared ") + id + dim(`  by ${by}`));
  say(dim(`  warrant covers fingerprint ${held.fingerprint} for ${policy.warrant.expires_after_days} days`));
  say(dim(`  valid only while rules ${held.rules} are unchanged`));
  if (held.proposal?.patch) {
    say("");
    process.stdout.write(held.proposal.patch);
    say(dim("  apply with: ") + cyan(`interlock clear ${id} --quiet | git apply`));
  } else if (held.proposal?.command) {
    say("");
    say("  run: " + cyan(held.proposal.command));
  }
}

function cmdClear(root, f) {
  // --quiet emits the patch only, so it can be piped straight into `git apply`
  if (f.quiet) {
    const policy = loadPolicy(root);
    const entries = readLedger(root, policy);
    const held = [...entries].reverse().find((e) => e.id === f._[0] && e.event === "hold");
    if (!held?.proposal?.patch) die("nothing to apply for that id");
    if (!entries.some((e) => e.of === f._[0] && e.event === "cleared")) die(`${f._[0]} has not been cleared yet`);
    return process.stdout.write(held.proposal.patch);
  }
  resolveHold(root, f, "cleared");
}

function cmdLog(root, f) {
  const policy = loadPolicy(root);
  const entries = readLedger(root, policy);
  if (f.json) return say(JSON.stringify(entries, null, 2));
  if (!entries.length) return say(dim("the ledger is empty — nothing has been gated yet"));

  if (f.verify) {
    const rules = ruleHash(policy);
    const drift = entries.filter((e) => e.rules && e.rules !== rules);
    const openById = new Map();
    for (const e of entries)
      if (e.event === "hold" && !entries.some((x) => x.of === e.id)) openById.set(e.id, e);
    const open = [...openById.values()];
    say(bold(`${entries.length} entries`) + dim(`  ·  rules in force now: ${rules}`));
    say((drift.length ? yellow("! ") : green("✔ ")) + `${drift.length} recorded under rules that no longer apply`);
    const stale = [...new Set(drift.filter((e) => e.event === "cleared").map((e) => e.fingerprint))];
    if (stale.length)
      say(dim(`  ${stale.length} past clearance${stale.length === 1 ? "" : "s"} void — those failures go back to a person`));
    say((open.length ? yellow("! ") : green("✔ ")) + `${open.length} still waiting on a person`);
    for (const e of open) say(dim(`  ${e.id}  ${e.class}  ${e.repo} run ${e.run}`));
    return;
  }

  const mark = {
    auto: green("auto"),
    hold: yellow("hold"),
    refuse: red("refuse"),
    cleared: green("cleared"),
    rejected: red("rejected"),
    reuse: cyan("reuse"),
    observed: dim("observed"),
    pass: dim("pass"),
  };
  for (const e of entries) {
    const who = e.by ? dim(" by " + e.by) : "";
    say(
      `${dim(e.ts.replace("T", " ").slice(0, 19))}  ${padVisible(mark[e.event] || e.event, 9)} ${e.id}  ${e.class}  ${dim(e.fingerprint)}${who}`
    );
  }
}

// ---------------------------------------------------------------- dispatch

const USAGE = `interlock ${VERSION} — the human interlock for self-healing CI

  interlock init                 write interlock.json and the ledger folder
  interlock lint [file]          check the policy            (exit 1 on failure — CI-friendly)
  interlock diagnose <log>       classify a CI log and propose a fix, no policy applied
  interlock gate <log>           diagnose, then apply the policy
  interlock clear <id>           approve a held fix and issue a warrant
  interlock reject <id>          refuse a held fix
  interlock log [--verify]       the record, and whether it still holds

  flags   --json  --patch  --slack  --repo <r>  --run <n>  --by "<name>"  --quiet  --force

  gate exit codes   0 auto-cleared   75 held, waiting on a person   1 refused
`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const f = flags(argv.slice(1));
const root = path.resolve(typeof f.root === "string" ? f.root : process.cwd());

switch (cmd) {
  case "init":
    cmdInit(root, f);
    break;
  case "lint":
    cmdLint(root, f);
    break;
  case "diagnose":
    cmdDiagnose(root, f);
    break;
  case "gate":
    cmdGate(root, f);
    break;
  case "clear":
    cmdClear(root, f);
    break;
  case "reject":
    resolveHold(root, f, "rejected");
    break;
  case "log":
    cmdLog(root, f);
    break;
  case "--version":
  case "-v":
    say(VERSION);
    break;
  default:
    say(USAGE);
    process.exit(cmd && cmd !== "--help" && cmd !== "-h" ? 1 : 0);
}

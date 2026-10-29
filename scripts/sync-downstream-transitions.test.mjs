// The stable sync after a reviewed non-ledger adaptation. The retired original and the commits that
// depend on it stay in alas history, so the replay must use the adaptation where the original was,
// and must not stop on a copy from an earlier sync whose change is already in the candidate.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "vitest";
import {buildSyncCandidate} from "./sync-candidate.mjs";
import {verifySyncSourceReview} from "./verify-sync-source-review.mjs";

let clock = 1_810_000_000;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {...process.env, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000`},
  }).trim();
}

function commitFiles(cwd, files, message) {
  clock += 60;
  for (const [path, contents] of Object.entries(files)) {
    const full = join(cwd, path);
    mkdirSync(join(full, ".."), {recursive: true});
    writeFileSync(full, contents);
    git(cwd, "add", path);
  }
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function patchIdOf(cwd, commit) {
  const patch = execFileSync("git", ["show", "--pretty=format:", "--binary", commit], {cwd, encoding: "utf8"});
  return execFileSync("git", ["patch-id", "--stable"], {cwd, encoding: "utf8", input: `${patch}\n`}).split(/\s+/)[0];
}

function build(f, {tag, base, ledger, ...options}) {
  return buildSyncCandidate({
    cwd: f.cwd,
    tagRef: tag,
    baseRef: base,
    upstreamRef: "upstream",
    alasRef: "alas",
    branch: `sync/upstream-${tag.slice(1)}`,
    syncRefs: [],
    ledger,
    expectedPatchIdentities: ledger.patches,
    ...options,
  });
}

function replayPoint(f, tag, exact, subject) {
  return git(f.cwd, "log", "--first-parent", "--format=%H %s", `${tag}..${exact}`)
    .split("\n").map((line) => line.split(" ")).find(([, ...words]) => words.join(" ") === subject)[0];
}

const TOOL = "first\ngap\nsecond\nthird\n";

// alas carries a ledger patch, a non-ledger metadata commit that v1.1.0 conflicts with, and a later
// fork commit that edits a file the metadata commit created. The v1.1.0 sync adapts the metadata
// commit and is merged into alas like a protected PR; v1.2.0 then only changes an unrelated file.
// `adaptedTool` lets the adaptation also edit a line near the later fix, so the v1.1.0 copy of that
// fix gets a different patch id while making the same change.
function fixture({adaptedTool = TOOL} = {}) {
  const root = mkdtempSync(join(tmpdir(), "alas-sync-transitions-"));
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  git(cwd, "init", "-b", "upstream", cwd);
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  const base = commitFiles(cwd, {
    "package.json": '{"version":"1.0.0"}\n',
    "meta.txt": "name: upstream\nversion: 1\n",
    "upstream.txt": "one\n",
  }, "old stable");
  git(cwd, "tag", "v1.0.0");

  git(cwd, "checkout", "-b", "alas", base);
  const patch = commitFiles(cwd, {"downstream.txt": "downstream\n"}, "downstream patch");
  const ledger = {
    schemaVersion: 2,
    baseTag: "v1.0.0",
    patches: [{
      name: "downstream",
      commit: patch,
      upstreamPr: null,
      files: ["downstream.txt"],
      tests: ["downstream.test.ts"],
    }],
    retiredCommits: [],
    preservedTransitions: [],
  };
  commitFiles(cwd, {"docs/alas-downstream-patches.json": `${JSON.stringify(ledger, null, 2)}\n`}, "record ledger");
  const metadata = commitFiles(cwd, {
    "meta.txt": "name: alas\nversion: 1\n",
    "tool.txt": TOOL,
  }, "build: prepare downstream metadata");
  const dependent = commitFiles(cwd, {"tool.txt": TOOL.replace("second", "SECOND")}, "fix: reuse downstream metadata");
  // Fork commits reach alas through PR merges. Dated like the fix it merges, this merge makes the
  // history walk list the original fix before the v1.1.0 adaptation, as on the real fork.
  git(cwd, "reset", "--hard", git(cwd, "commit-tree", `${dependent}^{tree}`, "-p", dependent, "-p", base,
    "-m", "Merge pull request #0 from nacho/reuse-metadata"));

  git(cwd, "checkout", "upstream");
  const stable = commitFiles(cwd, {
    "package.json": '{"version":"1.1.0"}\n',
    "meta.txt": "name: upstream2\nversion: 2\n",
  }, "new stable");
  git(cwd, "tag", "v1.1.0");
  const f = {root, cwd, base, patch, metadata, dependent, stable, ledger};

  // The reviewed v1.1.0 sync: the metadata commit conflicts and gets an adaptation that is stacked on
  // the exact candidate commit it is replayed onto.
  const first = {tag: "v1.1.0", base: "v1.0.0", ledger};
  const unresolved = build(f, first);
  assert.deepEqual(unresolved.conflicts, [{commit: metadata, kind: "downstream"}]);
  git(cwd, "checkout", "--detach", replayPoint(f, "v1.1.0", unresolved.exactCandidateCommit, "record ledger"));
  const adaptation = commitFiles(cwd, {
    "meta.txt": "name: alas\nversion: 2\n",
    "tool.txt": adaptedTool,
  }, "build: adapt downstream metadata to v1.1.0");
  const review = structuredClone(unresolved.syncReview);
  review.downstreamCommits = [{
    commit: metadata,
    subject: "build: prepare downstream metadata",
    patchId: patchIdOf(cwd, metadata),
    equivalentCommits: [],
    resolution: {
      action: "adapt",
      commit: adaptation,
      automatic: false,
      rationale: "Keeps the downstream name on top of the v1.1.0 manifest version.",
      tests: ["scripts/prepare-alas-package.test.mjs"],
    },
  }];
  const synced = build(f, {...first, reviewOverride: review});
  assert.deepEqual(synced.manualReviewReasons, []);
  git(cwd, "checkout", "alas");
  clock += 60;
  git(cwd, "merge", "--no-ff", "-m", "Merge pull request #1 from sync/upstream-1.1.0", synced.integrationCommit);
  const advanced = JSON.parse(readFileSync(join(cwd, "docs/alas-downstream-patches.json"), "utf8"));
  assert.deepEqual(advanced.retiredCommits, [metadata]);

  git(cwd, "checkout", "upstream");
  const next = commitFiles(cwd, {"package.json": '{"version":"1.2.0"}\n', "upstream.txt": "two\n"}, "next stable");
  git(cwd, "tag", "v1.2.0");
  return {...f, adaptation, advanced, next};
}

test("replays a reviewed non-ledger adaptation where its retired original was on the next stable sync", () => {
  const f = fixture();
  try {
    const report = build(f, {tag: "v1.2.0", base: "v1.1.0", ledger: f.advanced});
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.manualReviewReasons, []);
    assert.equal(git(f.cwd, "show", `${report.exactCandidateCommit}:tool.txt`), "first\ngap\nSECOND\nthird");
    assert.equal(git(f.cwd, "show", `${report.exactCandidateCommit}:meta.txt`), "name: alas\nversion: 2");
    const applied = report.appliedDownstreamCommits;
    assert.ok(applied.indexOf(f.adaptation) >= 0 && applied.indexOf(f.adaptation) < applied.indexOf(f.dependent));
    assert.equal(applied.filter((commit) => commit === f.adaptation).length, 1);
    assert.ok(!applied.includes(f.metadata));
    assert.deepEqual(report.redundantDownstreamCommits, []);

    const repeated = build(f, {tag: "v1.2.0", base: "v1.1.0", ledger: f.advanced});
    assert.equal(repeated.integrationCommit, report.integrationCommit);

    const wrapper = git(f.cwd, "commit-tree", `${report.integrationCommit}^{tree}`,
      "-p", git(f.cwd, "rev-parse", "alas"), "-p", report.integrationCommit, "-m", "Merge pull request #2");
    git(f.cwd, "branch", "alas-wrapper", wrapper);
    const verified = verifySyncSourceReview({
      cwd: f.cwd,
      sourceCommit: wrapper,
      alasRef: "alas-wrapper",
      upstreamTag: "v1.2.0",
      upstreamMainRef: "upstream",
      packageVersion: "1.2.0",
      review: report.syncReview,
      ledger: report.advancedLedger,
      expectedPatchIdentities: f.advanced.patches,
    });
    assert.equal(verified.reconstructedCandidateCommit, report.exactCandidateCommit);
    assert.equal(verified.reconstructedIntegrationCommit, report.integrationCommit);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("skips a non-ledger copy from an earlier sync whose change the candidate already has", () => {
  const f = fixture({adaptedTool: TOOL.replace("first", "first v1.1")});
  try {
    const copy = git(f.cwd, "log", "--format=%H %s", `v1.1.0..alas`).split("\n")
      .map((line) => line.split(" ")).filter(([, ...words]) => words.join(" ") === "fix: reuse downstream metadata")
      .map(([commit]) => commit).find((commit) => commit !== f.dependent);
    // The v1.1.0 sync replayed the fix onto the adapted context, so its copy has another patch id.
    assert.notEqual(patchIdOf(f.cwd, copy), patchIdOf(f.cwd, f.dependent));

    const report = build(f, {tag: "v1.2.0", base: "v1.1.0", ledger: f.advanced});
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.manualReviewReasons, []);
    assert.deepEqual(report.redundantDownstreamCommits, [copy]);
    assert.ok(report.appliedDownstreamCommits.includes(f.dependent));
    assert.ok(!report.appliedDownstreamCommits.includes(copy));
    assert.equal(git(f.cwd, "show", `${report.exactCandidateCommit}:tool.txt`), "first v1.1\ngap\nSECOND\nthird");
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("fails closed when a recorded adaptation replacement is not in protected alas", () => {
  const f = fixture();
  try {
    const ledger = structuredClone(f.advanced);
    ledger.downstreamTransitions[0].replacementCommit = f.next;
    assert.throws(() => build(f, {tag: "v1.2.0", base: "v1.1.0", ledger}), /not in protected alas/);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

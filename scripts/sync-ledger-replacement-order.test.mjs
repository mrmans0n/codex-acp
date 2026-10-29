// The stable sync after a reviewed ledger adaptation. The ledger patch's original stays in alas
// history, retired, and the adaptation reaches alas later through the sync merge. Fork commits that
// build on the patch sit between the two, so the replay must use the adaptation where the retired
// original was.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "vitest";
import {buildSyncCandidate} from "./sync-candidate.mjs";
import {verifySyncSourceReview} from "./verify-sync-source-review.mjs";

let clock = 1_820_000_000;

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

const FEATURE = "one\ntwo\nthree\nfour\n";
const UPSTREAM_FEATURE = FEATURE.replace("one", "ONE");

function patchIdOf(cwd, commit) {
  const patch = execFileSync("git", ["show", "--pretty=format:", "--binary", commit], {cwd, encoding: "utf8"});
  return execFileSync("git", ["patch-id", "--stable"], {cwd, encoding: "utf8", input: `${patch}\n`}).split(/\s+/)[0];
}

// alas carries a ledger patch that adds a line to feature.txt and a later fork commit that edits
// that line. v1.1.0 changes another line of the same file, so the v1.1.0 sync adapts the patch onto
// the tag and is merged into alas like a protected PR. v1.2.0 then only changes an unrelated file.
// When `upstreamFeature` changes the patch's context, the adaptation gets another patch id.
function fixture({upstreamFeature = UPSTREAM_FEATURE} = {}) {
  const root = mkdtempSync(join(tmpdir(), "alas-sync-ledger-order-"));
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  git(cwd, "init", "-b", "upstream", cwd);
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  const base = commitFiles(cwd, {
    "package.json": '{"version":"1.0.0"}\n',
    "feature.txt": FEATURE,
    "upstream.txt": "one\n",
  }, "old stable");
  git(cwd, "tag", "v1.0.0");

  git(cwd, "checkout", "-b", "alas", base);
  const patch = commitFiles(cwd, {"feature.txt": `${FEATURE}downstream\n`}, "feat: downstream feature");
  const dependent = commitFiles(cwd, {"feature.txt": `${FEATURE}downstream, refined\n`}, "fix: refine downstream feature");
  const ledger = {
    schemaVersion: 2,
    baseTag: "v1.0.0",
    patches: [{
      name: "downstream",
      commit: patch,
      upstreamPr: null,
      files: ["feature.txt"],
      tests: ["feature.test.ts"],
    }],
    retiredCommits: [],
    preservedTransitions: [],
  };
  const recorded = commitFiles(cwd, {"docs/alas-downstream-patches.json": `${JSON.stringify(ledger, null, 2)}\n`}, "record ledger");
  // Fork commits reach alas through PR merges. Dated like the last commit it merges, this merge makes
  // the history walk list the original fix before the v1.1.0 adaptation, as on the real fork.
  git(cwd, "reset", "--hard", git(cwd, "commit-tree", `${recorded}^{tree}`, "-p", recorded, "-p", base,
    "-m", "Merge pull request #0 from nacho/downstream-feature"));

  git(cwd, "checkout", "upstream");
  const stable = commitFiles(cwd, {
    "package.json": '{"version":"1.1.0"}\n',
    "feature.txt": upstreamFeature,
  }, "new stable");
  git(cwd, "tag", "v1.1.0");
  const f = {root, cwd, base, patch, dependent, stable, ledger};

  // The reviewed v1.1.0 sync: the patch overlaps the upstream edit and is adapted onto the tag.
  const first = {tag: "v1.1.0", base: "v1.0.0", ledger};
  const unresolved = build(f, first);
  assert.deepEqual(unresolved.syncReview.patches.map((entry) => entry.classification), ["overlap"]);
  git(cwd, "checkout", "--detach", stable);
  const adaptation = commitFiles(cwd, {"feature.txt": `${upstreamFeature}downstream\n`}, "feat: adapt downstream feature to v1.1.0");
  const review = structuredClone(unresolved.syncReview);
  review.patches[0].resolution = {
    action: "adapt",
    commit: adaptation,
    automatic: false,
    rationale: "Keeps the downstream line after the v1.1.0 context.",
    tests: ["feature.test.ts"],
  };
  const synced = build(f, {...first, reviewOverride: review});
  assert.deepEqual(synced.manualReviewReasons, []);
  git(cwd, "checkout", "alas");
  clock += 60;
  git(cwd, "merge", "--no-ff", "-m", "Merge pull request #1 from sync/upstream-1.1.0", synced.integrationCommit);
  const advanced = JSON.parse(readFileSync(join(cwd, "docs/alas-downstream-patches.json"), "utf8"));
  assert.equal(advanced.patches[0].appliedCommit, adaptation);
  assert.deepEqual(advanced.patches[0].retiredCommits, [patch]);

  git(cwd, "checkout", "upstream");
  const next = commitFiles(cwd, {"package.json": '{"version":"1.2.0"}\n', "upstream.txt": "two\n"}, "next stable");
  git(cwd, "tag", "v1.2.0");
  return {...f, upstreamFeature, adaptation, advanced, next};
}

for (const {variant, upstreamFeature, samePatchId} of [
  {variant: "keeps its original's patch id", upstreamFeature: UPSTREAM_FEATURE, samePatchId: true},
  {variant: "has another patch id", upstreamFeature: FEATURE.replace("three", "THREE"), samePatchId: false},
]) {
  test(`replays an adapted ledger patch that ${variant} where its retired original was on the next stable sync`, () => {
    const f = fixture({upstreamFeature});
    try {
      assert.equal(patchIdOf(f.cwd, f.adaptation) === patchIdOf(f.cwd, f.patch), samePatchId);
      const report = build(f, {tag: "v1.2.0", base: "v1.1.0", ledger: f.advanced});
      assert.deepEqual(report.conflicts, []);
      assert.deepEqual(report.manualReviewReasons, []);
      assert.deepEqual(report.appliedPatches, ["downstream"]);
      assert.equal(git(f.cwd, "show", `${report.exactCandidateCommit}:feature.txt`), `${f.upstreamFeature}downstream, refined`);
      const applied = report.appliedDownstreamCommits;
      assert.ok(applied.indexOf(f.adaptation) >= 0 && applied.indexOf(f.adaptation) < applied.indexOf(f.dependent));
      assert.equal(applied.filter((commit) => commit === f.adaptation).length, 1);
      assert.ok(!applied.includes(f.patch));

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
}

test("fails closed when an adapted ledger patch's applied commit is not in protected alas", () => {
  const f = fixture();
  try {
    const ledger = structuredClone(f.advanced);
    ledger.patches[0].appliedCommit = f.next;
    ledger.patches[0].lastResolution.replacementCommit = f.next;
    assert.throws(() => build(f, {tag: "v1.2.0", base: "v1.1.0", ledger}), /not in protected alas/);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

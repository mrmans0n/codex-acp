// Reviewed exceptions of a stable sync: an explicit adaptation of a conflicting non-ledger
// downstream commit, and explicit acceptance of upstream workflow changes while the candidate keeps
// the fork's workflows. Both must be reproduced exactly by publication verification.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "vitest";
import {buildSyncCandidate, pushSyncCandidate} from "./sync-candidate.mjs";
import {
  verifyReconstructedPatchState,
  verifySyncSourceReview,
} from "./verify-sync-source-review.mjs";

let clock = 1_800_000_000;

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

const CI = "name: ci\non: push\njobs: build\nsteps: lint\nrun: test\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alas-sync-exceptions-"));
  const cwd = join(root, "repo");
  const remote = join(root, "origin.git");
  mkdirSync(cwd);
  git(cwd, "init", "--bare", remote);
  git(cwd, "init", "-b", "upstream", cwd);
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  const base = commitFiles(cwd, {
    "package.json": '{"version":"1.0.0"}\n',
    "meta.txt": "name: upstream\nversion: 1\n",
    ".github/workflows/ci.yml": CI,
    ".github/workflows/e2e.yml": "name: e2e\n",
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
  // A non-ledger fork commit that the new stable release conflicts with.
  const metadata = commitFiles(cwd, {"meta.txt": "name: alas\nversion: 1\n"}, "build: prepare downstream metadata");
  // Fork workflow hardening: an edit to an upstream workflow plus a fork-owned workflow.
  commitFiles(cwd, {
    ".github/workflows/ci.yml": CI.replace("name: ci", "name: ci-hardened"),
    ".github/workflows/publish-alas.yml": "name: publish alas\n",
  }, "ci: harden fork workflows");
  // An earlier sync carried an equivalent copy of the metadata commit into alas.
  git(cwd, "checkout", "-b", "earlier-sync", base);
  const twin = commitFiles(cwd, {"meta.txt": "name: alas\nversion: 1\n"}, "build: prepare downstream metadata (copy)");
  git(cwd, "checkout", "alas");
  clock += 60;
  git(cwd, "merge", "--no-ff", "-m", "merge earlier sync", "earlier-sync");
  const alas = git(cwd, "rev-parse", "HEAD");

  git(cwd, "checkout", "upstream");
  const stable = commitFiles(cwd, {
    "package.json": '{"version":"1.1.0"}\n',
    "meta.txt": "name: upstream2\nversion: 2\n",
    ".github/workflows/ci.yml": CI.replace("run: test", "run: test && npm run test:integration"),
    ".github/workflows/e2e.yml": "name: e2e\nnode: 24\n",
  }, "new stable");
  git(cwd, "tag", "v1.1.0");
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "origin", "alas");
  return {root, cwd, remote, base, patch, metadata, twin, alas, stable, ledger};
}

function build(f, options = {}) {
  return buildSyncCandidate({
    cwd: f.cwd,
    tagRef: "v1.1.0",
    baseRef: "v1.0.0",
    upstreamRef: "upstream",
    alasRef: "alas",
    branch: "sync/upstream-1.1.0",
    syncRefs: [],
    ledger: f.ledger,
    expectedPatchIdentities: f.ledger.patches,
    ...options,
  });
}

const workflowResolution = {
  action: "retain-downstream",
  automatic: false,
  rationale: "The upstream CI edit needs a script that only exists from this stable release; it is mirrored into alas by a separate automation PR after the sync.",
  tests: ["scripts/sync-upstream.test.mjs"],
};

function adaptationResolution(commit) {
  return {
    action: "adapt",
    commit,
    automatic: false,
    rationale: "Keeps the downstream package name on top of the new stable manifest version.",
    tests: ["scripts/prepare-alas-package.test.mjs"],
  };
}

// Replays the unresolved build, writes the metadata adaptation on the exact candidate commit it is
// replayed onto, and returns the fully resolved review.
function resolve(f, {parent, files = {"meta.txt": "name: alas\nversion: 2\n"}} = {}) {
  const unresolved = build(f);
  assert.deepEqual(unresolved.conflicts, [{commit: f.metadata, kind: "downstream"}]);
  const replayPoint = git(f.cwd, "log", "--first-parent", "--format=%H %s", `${f.stable}..${unresolved.exactCandidateCommit}`)
    .split("\n").map((line) => line.split(" ")).find(([, ...subject]) => subject.join(" ") === "record ledger")[0];
  git(f.cwd, "checkout", "--detach", parent ?? replayPoint);
  const adaptation = commitFiles(f.cwd, files, "build: adapt downstream metadata to the new stable");
  const review = structuredClone(unresolved.syncReview);
  review.downstreamCommits = [{
    commit: f.metadata,
    subject: "build: prepare downstream metadata",
    patchId: patchIdOf(f.cwd, f.metadata),
    equivalentCommits: [f.twin],
    resolution: adaptationResolution(adaptation),
  }];
  review.upstreamWorkflowChanges = review.upstreamWorkflowChanges
    .map((entry) => ({...entry, resolution: workflowResolution}));
  return {unresolved, replayPoint, adaptation, review};
}

function workflowTree(cwd, ref) {
  return git(cwd, "rev-parse", `${ref}:.github/workflows`);
}

test("binds a reviewed non-ledger adaptation and accepts listed upstream workflow changes", () => {
  const f = fixture();
  try {
    const {unresolved, adaptation, review} = resolve(f);
    assert.deepEqual(unresolved.workflowChanges, [".github/workflows/ci.yml", ".github/workflows/e2e.yml"]);
    assert.ok(unresolved.manualReviewReasons.includes("upstream-workflow-changes"));
    assert.ok(unresolved.manualReviewReasons.includes("cherry-pick-conflicts"));

    const report = build(f, {reviewOverride: review});
    assert.deepEqual(report.manualReviewReasons, []);
    assert.equal(report.manualReview, false);
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.appliedDownstreamAdaptations, [{commit: f.metadata, replacementCommit: adaptation}]);
    assert.deepEqual(report.acceptedWorkflowChanges, report.workflowChanges);
    assert.equal(git(f.cwd, "merge-base", "--is-ancestor", adaptation, report.exactCandidateCommit), "");
    assert.equal(git(f.cwd, "show", `${report.exactCandidateCommit}:meta.txt`), "name: alas\nversion: 2");
    // The fork's workflows are kept exactly; the upstream workflow edits are not imported.
    assert.equal(workflowTree(f.cwd, report.exactCandidateCommit), workflowTree(f.cwd, "alas"));
    // The equivalent earlier copy is not replayed again, and both copies are retired.
    assert.ok(!report.appliedDownstreamCommits.includes(f.twin));
    assert.deepEqual(report.advancedLedger.retiredCommits, [f.metadata, f.twin]);
    assert.equal(report.advancedLedger.downstreamTransitions[0].replacementCommit, adaptation);

    const repeated = build(f, {reviewOverride: review});
    assert.equal(repeated.integrationCommit, report.integrationCommit);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("reruns on its own canonical integration without rewriting it", () => {
  const f = fixture();
  try {
    const branch = "sync/upstream-1.1.0";
    const {review} = resolve(f);
    const resolved = build(f, {reviewOverride: review});
    pushSyncCandidate({cwd: f.cwd, branch, expectedRemoteSha: "", ref: resolved.integrationCommit});
    git(f.cwd, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    const rerun = build(f, {syncRefs: [`origin/${branch}`]});
    assert.deepEqual(rerun.manualReviewReasons, []);
    assert.deepEqual(rerun.unsupportedMergeCommits, []);
    assert.equal(rerun.canonicalHead, null);
    assert.deepEqual(rerun.syncReview, resolved.syncReview);
    assert.equal(rerun.exactCandidateCommit, resolved.exactCandidateCommit);
    assert.equal(rerun.integrationCommit, resolved.integrationCommit);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("keeps an unlisted or unaccepted upstream workflow change in manual review", () => {
  const f = fixture();
  try {
    const {review} = resolve(f);
    const unlisted = structuredClone(review);
    unlisted.upstreamWorkflowChanges = unlisted.upstreamWorkflowChanges.slice(0, 1);
    const wrongAction = structuredClone(review);
    wrongAction.upstreamWorkflowChanges[1].resolution = {...workflowResolution, action: "retain"};
    for (const override of [unlisted, wrongAction]) {
      const report = build(f, {reviewOverride: override});
      assert.ok(report.manualReviewReasons.includes("upstream-workflow-changes"));
      assert.ok(report.manualReviewReasons.includes("sync-review-unresolved"));
      assert.deepEqual(report.acceptedWorkflowChanges, []);
      assert.deepEqual(report.advancedLedger, f.ledger);
    }
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("never accepts an upstream change to a fork-owned workflow", () => {
  const f = fixture();
  try {
    const {review} = resolve(f);
    git(f.cwd, "checkout", "upstream");
    commitFiles(f.cwd, {
      "package.json": '{"version":"1.2.0"}\n',
      // Even a byte-identical copy of the fork's own workflow is an upstream change to it.
      ".github/workflows/publish-alas.yml": "name: publish alas\n",
    }, "upstream adds a workflow the fork owns");
    git(f.cwd, "tag", "v1.2.0");
    const options = {tagRef: "v1.2.0", branch: "sync/upstream-1.2.0"};
    const unresolved = build(f, options);
    assert.deepEqual(unresolved.forkWorkflowChanges, [".github/workflows/publish-alas.yml"]);
    const accepted = structuredClone(unresolved.syncReview);
    accepted.downstreamCommits = review.downstreamCommits;
    accepted.upstreamWorkflowChanges = accepted.upstreamWorkflowChanges
      .map((entry) => ({...entry, resolution: workflowResolution}));
    // The adaptation was written for v1.1.0, so rebuild it on the v1.2.0 replay point.
    const replayPoint = git(f.cwd, "log", "--first-parent", "--format=%H %s", `v1.2.0..${unresolved.exactCandidateCommit}`)
      .split("\n").map((line) => line.split(" ")).find(([, ...subject]) => subject.join(" ") === "record ledger")[0];
    git(f.cwd, "checkout", "--detach", replayPoint);
    const adaptation = commitFiles(f.cwd, {"meta.txt": "name: alas\nversion: 2\n"}, "adapt metadata to v1.2.0");
    accepted.downstreamCommits = [{...review.downstreamCommits[0], resolution: adaptationResolution(adaptation)}];
    const report = build(f, {...options, reviewOverride: accepted});
    assert.equal(report.syncReviewError, null);
    assert.deepEqual(report.manualReviewReasons, ["upstream-workflow-changes", "upstream-fork-workflow-changes"]);
    assert.equal(workflowTree(f.cwd, report.exactCandidateCommit), workflowTree(f.cwd, "alas"));

    git(f.cwd, "branch", "alas-source", report.integrationCommit);
    assert.throws(() => verifySyncSourceReview({
      cwd: f.cwd,
      sourceCommit: report.integrationCommit,
      alasRef: "alas-source",
      upstreamTag: "v1.2.0",
      upstreamMainRef: "upstream",
      packageVersion: "1.2.0",
      review: report.syncReview,
      ledger: report.advancedLedger,
      expectedPatchIdentities: f.ledger.patches,
    }), /fork-owned workflows/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("rejects a non-ledger adaptation with a wrong parent, extra files, or a non-deterministic parent", () => {
  const f = fixture();
  try {
    // Parent outside the exact stable tag history.
    const wrongParent = resolve(f, {parent: f.base});
    assert.throws(() => build(f, {reviewOverride: wrongParent.review}), /directly descend/i);

    // A path the original non-ledger commit does not change.
    const extraFiles = resolve(f, {files: {"meta.txt": "name: alas\nversion: 2\n", "other.txt": "extra\n"}});
    assert.throws(() => build(f, {reviewOverride: extraFiles.review}), /unproven tree effect.*other\.txt/i);

    // Stacked on a same-tree lookalike of the replay point (for example a local replay with another
    // committer or date) instead of the deterministic candidate commit.
    const {replayPoint} = resolve(f);
    clock += 3600;
    const lookalike = git(f.cwd, "commit-tree", `${replayPoint}^{tree}`, "-p", `${replayPoint}^1`,
      "-m", git(f.cwd, "show", "-s", "--format=%B", replayPoint));
    const nonDeterministic = resolve(f, {parent: lookalike});
    assert.throws(() => build(f, {reviewOverride: nonDeterministic.review}), /directly descend/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("rejects adaptation entries that do not name the replayed non-ledger commit identity", () => {
  const f = fixture();
  try {
    const {review} = resolve(f);
    const entry = review.downstreamCommits[0];
    for (const [commit, reason] of [
      [f.twin, /first replayed copy/],
      [f.patch, /ledger patch/],
      [f.stable, /not a downstream commit/],
    ]) {
      const override = structuredClone(review);
      override.downstreamCommits = [{...entry, commit}];
      const report = build(f, {reviewOverride: override});
      assert.match(report.invalidDownstreamCommits[0].reason, reason);
      assert.ok(report.manualReviewReasons.includes("invalid-downstream-adaptations"));
      assert.equal(report.syncReview.downstreamCommits, undefined);
      assert.deepEqual(report.advancedLedger, f.ledger);
    }

    // A wrong recorded identity resets the resolution instead of binding the adaptation.
    const wrongIdentity = structuredClone(review);
    wrongIdentity.downstreamCommits[0].equivalentCommits = [];
    const report = build(f, {reviewOverride: wrongIdentity});
    assert.equal(report.syncReview.downstreamCommits[0].resolution.action, null);
    assert.deepEqual(report.appliedDownstreamAdaptations, []);
    assert.ok(report.manualReviewReasons.includes("sync-review-unresolved"));
    assert.ok(report.manualReviewReasons.includes("cherry-pick-conflicts"));
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

function published(f) {
  const {review} = resolve(f);
  const report = build(f, {reviewOverride: review});
  const wrapper = git(f.cwd, "commit-tree", `${report.integrationCommit}^{tree}`,
    "-p", f.alas, "-p", report.integrationCommit, "-m", "Merge pull request #7");
  git(f.cwd, "branch", "alas-wrapper", wrapper);
  return {report, wrapper};
}

function verify(f, report, overrides = {}) {
  return verifySyncSourceReview({
    cwd: f.cwd,
    sourceCommit: report.integrationCommit,
    alasRef: "alas-wrapper",
    upstreamTag: "v1.1.0",
    upstreamMainRef: "upstream",
    packageVersion: "1.1.0",
    review: report.syncReview,
    ledger: report.advancedLedger,
    expectedPatchIdentities: f.ledger.patches,
    ...overrides,
  });
}

test("publication verification reproduces the accepted exceptions on a protected merge wrapper", () => {
  const f = fixture();
  try {
    const {report, wrapper} = published(f);
    const result = verify(f, report, {sourceCommit: wrapper});
    assert.equal(result.integrationCommit, report.integrationCommit);
    assert.equal(result.reconstructedCandidateCommit, report.exactCandidateCommit);
    assert.equal(result.reconstructedIntegrationCommit, report.integrationCommit);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("publication verification rejects modified fork workflows and unreproduced exceptions", () => {
  const f = fixture();
  try {
    const {report} = published(f);
    // A same-shaped integration whose exact candidate changes a fork workflow.
    git(f.cwd, "checkout", "--detach", report.exactCandidateCommit);
    const forgedExact = commitFiles(f.cwd, {".github/workflows/ci.yml": `${CI}extra: step\n`}, "import upstream ci");
    const forgedIntegration = git(f.cwd, "commit-tree", `${forgedExact}^{tree}`, "-p", f.alas, "-p", forgedExact,
      "-m", `chore: integrate exact upstream ${f.stable.slice(0, 12)}`);
    git(f.cwd, "branch", "alas-forged", forgedIntegration);
    assert.throws(() => verify(f, report, {sourceCommit: forgedIntegration, alasRef: "alas-forged"}),
      /workflows differ/i);

    const reconstructed = {
      appliedPatches: ["downstream"],
      appliedAdaptations: [],
      missingLedgerPatches: [],
      manualReview: false,
      exactCandidateCommit: report.exactCandidateCommit,
      preservedSyncCommits: [],
      appliedPreservedAdaptations: [],
      appliedDownstreamAdaptations: report.appliedDownstreamAdaptations,
      invalidDownstreamCommits: [],
      unappliedDownstreamAdaptations: [],
      workflowChanges: report.workflowChanges,
      acceptedWorkflowChanges: report.acceptedWorkflowChanges,
      forkWorkflowChanges: [],
    };
    const check = (overrides) => verifyReconstructedPatchState({
      cwd: f.cwd,
      reconstructed: {...reconstructed, ...overrides},
      review: report.syncReview,
      ledger: report.advancedLedger,
    });
    assert.equal(check({}), true);
    for (const overrides of [
      {appliedDownstreamAdaptations: []},
      {unappliedDownstreamAdaptations: [f.metadata]},
      {acceptedWorkflowChanges: []},
      {workflowChanges: [...report.workflowChanges, ".github/workflows/invented.yml"]},
      {forkWorkflowChanges: [".github/workflows/publish-alas.yml"]},
    ]) {
      assert.throws(() => check(overrides), /downstream adaptations|workflow changes/i);
    }
    // The bound adaptation must be in the exact candidate ancestry.
    assert.throws(() => check({exactCandidateCommit: f.stable}), /ancestry/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

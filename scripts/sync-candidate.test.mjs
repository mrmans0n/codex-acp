import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "vitest";
import {buildSyncCandidate, pushSyncCandidate, verifyRemoteSyncHeads} from "./sync-candidate.mjs";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

function commitFile(cwd, path, contents, message) {
  writeFileSync(join(cwd, path), contents);
  git(cwd, "add", path);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alas-sync-candidate-"));
  const cwd = join(root, "repo");
  const remote = join(root, "origin.git");
  mkdirSync(cwd);
  git(cwd, "init", "--bare", remote);
  git(cwd, "init", "-b", "upstream", cwd);
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  writeFileSync(join(cwd, "base.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "old stable");
  const base = git(cwd, "rev-parse", "HEAD");
  const stable = commitFile(cwd, "stable.txt", "stable\n", "new stable");
  git(cwd, "tag", "v2.0.0", base);
  git(cwd, "tag", "v2.1.0", stable);
  writeFileSync(join(cwd, "preview-only.txt"), "must not leak\n");
  git(cwd, "add", "preview-only.txt");
  git(cwd, "commit", "-m", "preview after stable");
  const preview = git(cwd, "rev-parse", "HEAD");

  git(cwd, "checkout", "-b", "alas", base);
  const patch = commitFile(cwd, "downstream.txt", "downstream\n", "downstream patch");
  const maintenance = commitFile(cwd, "maintenance.txt", "fork maintenance\n", "downstream maintenance");
  const alas = git(cwd, "rev-parse", "HEAD");
  git(cwd, "branch", "sync/upstream-2.1.0");
  git(cwd, "checkout", "sync/upstream-2.1.0");
  const maintainer = commitFile(cwd, "maintainer.txt", "review edit\n", "maintainer review edit");
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "origin", "alas", "sync/upstream-2.1.0");

  const ledger = {
    schemaVersion: 2,
    baseTag: "v2.0.0",
    patches: [{
      name: "downstream",
      commit: patch,
      upstreamPr: null,
      files: ["downstream.txt"],
      tests: ["downstream.test.ts"],
    }],
  };
  return {root, cwd, remote, base, stable, preview, alas, patch, maintenance, maintainer, ledger};
}

test("keeps an exact-tag candidate and creates a protected-branch-descended no-ff integration", () => {
  const f = fixture();
  try {
    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch: "sync/upstream-2.1.0",
      syncRefs: ["origin/sync/upstream-2.1.0"],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    const head = git(f.cwd, "rev-parse", "HEAD");
    assert.equal(head, report.integrationCommit);
    assert.equal(git(f.cwd, "merge-base", head, "upstream"), f.stable);
    assert.equal(git(f.cwd, "rev-parse", `${head}^1`), f.alas);
    assert.equal(git(f.cwd, "rev-parse", `${head}^2`), report.exactCandidateCommit);
    assert.equal(git(f.cwd, "rev-parse", `${head}^3`), f.maintainer);
    assert.equal(git(f.cwd, "rev-parse", report.exactBranch), report.exactCandidateCommit);
    assert.equal(existsSync(join(f.cwd, "preview-only.txt")), false);
    assert.equal(existsSync(join(f.cwd, "downstream.txt")), true);
    assert.equal(existsSync(join(f.cwd, "maintenance.txt")), true);
    assert.equal(existsSync(join(f.cwd, "maintainer.txt")), true);
    assert.deepEqual(report.appliedPatches, ["downstream"]);
    assert.ok(report.appliedDownstreamCommits.includes(f.maintenance));
    assert.deepEqual(report.preservedSyncCommits, [f.maintainer]);
    assert.equal(report.manualReview, true);
    assert.deepEqual(report.manualReviewReasons, [
      "sync-review-unresolved",
      "preserved-canonical-sync-commits",
    ]);
    const review = JSON.parse(readFileSync(join(f.cwd, "docs/alas-sync-review.json"), "utf8"));
    assert.equal(review.fromTag, "v2.0.0");
    assert.equal(review.toTag, "v2.1.0");
    assert.equal(review.toCommit, f.stable);
    assert.equal(review.canonicalHead, f.maintainer);
    assert.deepEqual(review.preservedCommits.map(({commit, subject, constituentCommits}) => ({commit, subject, constituentCommits})), [{
      commit: f.maintainer,
      subject: "maintainer review edit",
      constituentCommits: [],
    }]);
    assert.equal(review.patches[0].classification, "unaffected");
    assert.equal(review.patches[0].resolution.automatic, true);
    assert.equal(JSON.parse(git(f.cwd, "show", `${report.exactCandidateCommit}:docs/alas-sync-review.json`)).toCommit, f.stable);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("uses an explicit force-with-lease and rejects a concurrent canonical-branch update", () => {
  const f = fixture();
  try {
    const branch = "sync/upstream-2.1.0";
    const expected = git(f.cwd, "rev-parse", `origin/${branch}`);
    git(f.cwd, "checkout", branch);
    const concurrent = commitFile(f.cwd, "late.txt", "late\n", "late concurrent edit");
    git(f.cwd, "push", "origin", `HEAD:refs/heads/concurrent-object`);
    buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch,
      syncRefs: [`origin/${branch}`],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    git(f.cwd, `--git-dir=${f.remote}`, "update-ref", `refs/heads/${branch}`, concurrent);
    assert.throws(() => pushSyncCandidate({cwd: f.cwd, branch, expectedRemoteSha: expected}), /rejected|stale info/i);
    assert.equal(git(f.cwd, `--git-dir=${f.remote}`, "rev-parse", `refs/heads/${branch}`), concurrent);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("refuses to push a sync candidate directly to the protected alas branch", () => {
  const f = fixture();
  try {
    assert.throws(() => pushSyncCandidate({
      cwd: f.cwd,
      branch: "alas",
      expectedRemoteSha: f.alas,
    }), /protected.*alas/i);
    assert.equal(git(f.cwd, `--git-dir=${f.remote}`, "rev-parse", "refs/heads/alas"), f.alas);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("refuses to force-update branches outside the owned sync namespace", () => {
  const f = fixture();
  try {
    assert.throws(() => pushSyncCandidate({
      cwd: f.cwd,
      branch: "main",
      expectedRemoteSha: "",
    }), /owned sync/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("detects a concurrent update on every source sync branch before retiring it", () => {
  const f = fixture();
  try {
    const branch = "sync/upstream-2.1.0";
    const expected = git(f.cwd, "rev-parse", `origin/${branch}`);
    git(f.cwd, "checkout", branch);
    const concurrent = commitFile(f.cwd, "late.txt", "late\n", "late concurrent edit");
    git(f.cwd, "push", "origin", `HEAD:refs/heads/${branch}`);
    assert.deepEqual(verifyRemoteSyncHeads({
      cwd: f.cwd,
      syncHeads: [{ref: `origin/${branch}`, head: expected}],
    }), [{branch, expected, actual: concurrent}]);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("reports stale sync heads without replaying their commits", () => {
  const f = fixture();
  try {
    const reviewBranch = "sync/upstream-2.0.9";
    git(f.cwd, "checkout", "-b", reviewBranch, "alas");
    const stale = commitFile(f.cwd, "stale.txt", "stale review edit\n", "stale review edit");
    git(f.cwd, "push", "origin", reviewBranch);
    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch: "sync/upstream-2.1.0",
      syncRefs: [`origin/${reviewBranch}`],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.deepEqual(report.staleSyncHeads, [{
      ref: `origin/${reviewBranch}`,
      head: stale,
      commits: [stale],
    }]);
    assert.deepEqual(report.preservedSyncCommits, []);
    assert.equal(existsSync(join(f.cwd, "stale.txt")), false);
    assert.equal(existsSync(join(f.cwd, "preview-only.txt")), false);
    assert.equal(readFileSync(join(f.cwd, "stable.txt"), "utf8"), "stable\n");
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("fails closed when a source sync branch contains an unreviewed merge commit", () => {
  const f = fixture();
  try {
    const reviewBranch = "sync/upstream-2.0.9";
    git(f.cwd, "checkout", "-b", "review-side", "alas");
    commitFile(f.cwd, "side.txt", "side\n", "side review edit");
    git(f.cwd, "checkout", "-b", reviewBranch, "alas");
    commitFile(f.cwd, "mainline.txt", "mainline\n", "mainline review edit");
    git(f.cwd, "merge", "--no-ff", "review-side", "-m", "merge reviewed edits");
    const merge = git(f.cwd, "rev-parse", "HEAD");
    git(f.cwd, "push", "origin", reviewBranch);
    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch: "sync/upstream-2.1.0",
      syncRefs: [`origin/${reviewBranch}`],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.equal(report.manualReview, false);
    assert.deepEqual(report.unsupportedMergeCommits, []);
    assert.deepEqual(report.staleSyncHeads, [{
      ref: `origin/${reviewBranch}`,
      head: merge,
      commits: git(f.cwd, "rev-list", "--reverse", "--no-merges", `alas..origin/${reviewBranch}`).split("\n"),
    }]);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("fails closed on a non-generated merge in the canonical same-version sync branch", () => {
  const f = fixture();
  try {
    const branch = "sync/upstream-2.1.0";
    git(f.cwd, "checkout", "-b", "canonical-side", `origin/${branch}`);
    commitFile(f.cwd, "canonical-side.txt", "side\n", "canonical side edit");
    git(f.cwd, "checkout", branch);
    commitFile(f.cwd, "canonical-main.txt", "main\n", "canonical main edit");
    git(f.cwd, "merge", "--no-ff", "canonical-side", "-m", "merge canonical review edits");
    const merge = git(f.cwd, "rev-parse", "HEAD");
    git(f.cwd, "push", "--force", "origin", branch);
    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch,
      syncRefs: [`origin/${branch}`],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.ok(report.unsupportedMergeCommits.includes(merge));
    assert.ok(report.manualReviewReasons.includes("canonical-sync-merge-commits"));
    assert.equal(report.manualReview, true);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("does not mistake previously generated downstream cherry-picks for review commits", () => {
  const f = fixture();
  try {
    const branch = "sync/upstream-2.1.0";
    buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch,
      syncRefs: [],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    const oldRemote = git(f.cwd, "rev-parse", `origin/${branch}`);
    pushSyncCandidate({cwd: f.cwd, branch, expectedRemoteSha: oldRemote});
    git(f.cwd, "fetch", "origin", branch);
    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch,
      syncRefs: [`origin/${branch}`],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.preservedSyncCommits, []);
    assert.equal(report.manualReview, false);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("recognizes a prior three-parent generated integration and preserves only its canonical edits", () => {
  const f = fixture();
  try {
    const branch = "sync/upstream-2.1.0";
    const first = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch,
      syncRefs: [`origin/${branch}`],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    pushSyncCandidate({
      cwd: f.cwd,
      branch,
      expectedRemoteSha: f.maintainer,
      ref: first.integrationCommit,
    });
    git(f.cwd, "fetch", "origin", branch);
    const second = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch,
      syncRefs: [`origin/${branch}`],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.deepEqual(second.unsupportedMergeCommits, []);
    assert.deepEqual(second.preservedSyncCommits, [f.maintainer]);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("replays only the active adapted patch and skips its retired original commit", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "-b", "adaptation", f.base);
    const adapted = commitFile(f.cwd, "downstream.txt", "adapted downstream\n", "adapt downstream patch");
    git(f.cwd, "checkout", "alas");
    git(f.cwd, "merge", "--no-ff", "-X", "theirs", "adaptation", "-m", "integrate adapted patch");
    const ledger = {
      ...f.ledger,
      patches: [{
        ...f.ledger.patches[0],
        appliedCommit: adapted,
        retiredCommits: [f.patch],
        disposition: "active",
      }],
    };
    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch: "sync/upstream-2.1.0",
      syncRefs: [],
      ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.equal(report.appliedDownstreamCommits.includes(f.patch), false);
    assert.equal(report.appliedDownstreamCommits.includes(adapted), true);
    assert.deepEqual(report.appliedPatches, ["downstream"]);
    assert.deepEqual(report.missingLedgerPatches, []);
    assert.equal(readFileSync(join(f.cwd, "downstream.txt"), "utf8"), "adapted downstream\n");
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("excludes and reports a non-ledger cherry-pick equivalent to upstream main but absent from the stable tag", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "alas");
    git(f.cwd, "cherry-pick", f.preview);
    const cherryPickedPreview = git(f.cwd, "rev-parse", "HEAD");
    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch: "sync/upstream-2.1.0",
      syncRefs: [],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.equal(existsSync(join(f.cwd, "preview-only.txt")), false);
    assert.deepEqual(report.excludedUpstreamLaterEquivalents, [{
      commit: cherryPickedPreview,
      upstreamCommit: f.preview,
    }]);
    assert.equal(report.appliedDownstreamCommits.includes(cherryPickedPreview), false);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("excludes and reports canonical sync commits equivalent to the stable tag or later upstream main", () => {
  const f = fixture();
  try {
    const branch = "sync/upstream-2.1.0";
    git(f.cwd, "checkout", branch);
    git(f.cwd, "cherry-pick", f.stable);
    const stableEquivalent = git(f.cwd, "rev-parse", "HEAD");
    git(f.cwd, "cherry-pick", f.preview);
    const laterEquivalent = git(f.cwd, "rev-parse", "HEAD");
    git(f.cwd, "push", "--force", "origin", branch);

    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch,
      syncRefs: [`origin/${branch}`],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });

    assert.deepEqual(report.excludedCanonicalUpstreamEquivalents, [{
      commit: stableEquivalent,
      upstreamCommit: f.stable,
    }]);
    assert.deepEqual(report.excludedCanonicalUpstreamLaterEquivalents, [{
      commit: laterEquivalent,
      upstreamCommit: f.preview,
    }]);
    assert.equal(report.preservedSyncCommits.includes(stableEquivalent), false);
    assert.equal(report.preservedSyncCommits.includes(laterEquivalent), false);
    assert.equal(existsSync(join(f.cwd, "preview-only.txt")), false);
    assert.ok(report.manualReviewReasons.includes("excluded-canonical-sync-upstream-equivalents"));
    assert.ok(report.manualReviewReasons.includes("excluded-canonical-sync-upstream-later-equivalents"));
    assert.equal(report.manualReview, true);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("fails closed when origin alas contains upstream contamination not contained by the target stable tag", () => {
  const f = fixture();
  try {
    git(f.cwd, "branch", "contaminated", f.preview);
    assert.throws(() => buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "contaminated",
      branch: "sync/upstream-2.1.0",
      syncRefs: [],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    }), /contamination.*not contained/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("restores the downstream workflow tree while reporting upstream workflow changes", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "upstream");
    mkdirSync(join(f.cwd, ".github/workflows"), {recursive: true});
    commitFile(f.cwd, ".github/workflows/upstream.yml", "name: Upstream\n", "upstream workflow");
    git(f.cwd, "tag", "v2.2.0");
    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.2.0",
      baseRef: "v2.1.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch: "sync/upstream-2.2.0",
      syncRefs: [],
      ledger: {...f.ledger, baseTag: "v2.1.0"},
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.deepEqual(report.workflowChanges, [".github/workflows/upstream.yml"]);
    assert.equal(existsSync(join(f.cwd, ".github/workflows/upstream.yml")), false);
    assert.equal(report.manualReview, true);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

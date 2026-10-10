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
    assert.equal(second.canonicalHead, f.maintainer);
    assert.equal(second.integrationCommit, first.integrationCommit);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 15_000);

test("applies and binds an exact adaptation of a preserved canonical commit", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "-b", "preserved-adaptation", f.stable);
    const adapted = commitFile(f.cwd, "maintainer.txt", "adapted review edit\n", "adapt canonical review edit");
    const unresolved = buildSyncCandidate({
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
    const review = structuredClone(unresolved.syncReview);
    review.preservedCommits[0].resolution = {
      action: "adapt",
      commit: adapted,
      automatic: false,
      rationale: "Apply the stable-based canonical adaptation.",
      tests: ["npm run test:maintenance"],
    };
    review.resolved = true;
    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch: "sync/upstream-2.1.0",
      syncRefs: ["origin/sync/upstream-2.1.0"],
      reviewOverride: review,
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.equal(readFileSync(join(f.cwd, "maintainer.txt"), "utf8"), "adapted review edit\n");
    assert.equal(git(f.cwd, "merge-base", "--is-ancestor", adapted, report.exactCandidateCommit), "");
    assert.deepEqual(report.preservedSyncCommits, [adapted]);
    assert.deepEqual(report.appliedPreservedAdaptations, [{commit: f.maintainer, replacementCommit: adapted}]);
    assert.equal(report.manualReview, false);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects a generated-looking canonical integration whose provenance parent is not protected-head-descended", () => {
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
      syncRefs: [],
      ledger: f.ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    const forged = git(f.cwd, "commit-tree", `${first.exactCandidateCommit}^{tree}`,
      "-p", f.alas, "-p", first.exactCandidateCommit, "-p", f.base,
      "-m", `chore: integrate exact upstream ${f.stable.slice(0, 12)}`);
    git(f.cwd, "push", "--force", "origin", `${forged}:refs/heads/${branch}`);
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
    assert.ok(report.unsupportedMergeCommits.includes(forged));
    assert.ok(report.manualReviewReasons.includes("canonical-sync-merge-commits"));
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects a generated-looking patch binding whose tree is not the exact second-parent effect", () => {
  const f = fixture();
  try {
    const branch = "sync/upstream-2.1.0";
    git(f.cwd, "checkout", "-b", "exact-patch-parent", f.base);
    const exact = commitFile(f.cwd, "bound.txt", "exact effect\n", "exact patch effect");
    const firstParent = git(f.cwd, "rev-parse", `origin/${branch}`);
    git(f.cwd, "checkout", "--detach", firstParent);
    writeFileSync(join(f.cwd, "bound.txt"), "forged effect\n");
    git(f.cwd, "add", "bound.txt");
    const forgedTree = git(f.cwd, "write-tree");
    const forged = git(f.cwd, "commit-tree", forgedTree,
      "-p", firstParent, "-p", exact,
      "-m", `chore: bind exact adaptation ${exact.slice(0, 12)} for downstream`);
    git(f.cwd, "push", "--force", "origin", `${forged}:refs/heads/${branch}`);
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
    assert.ok(report.unsupportedMergeCommits.includes(forged));
    assert.ok(report.manualReviewReasons.includes("canonical-sync-merge-commits"));
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("recognizes an exact patch binding without replaying an earlier dropped second-parent ancestor", () => {
  const f = fixture();
  try {
    const branch = "sync/upstream-2.1.0";
    git(f.cwd, "checkout", "-b", "exact-patch-history", f.base);
    commitFile(f.cwd, "dropped.txt", "dropped effect\n", "earlier dropped patch");
    const retained = commitFile(f.cwd, "retained.txt", "retained effect\n", "later retained patch");
    const firstParent = git(f.cwd, "rev-parse", `origin/${branch}`);
    git(f.cwd, "checkout", "--detach", firstParent);
    git(f.cwd, "cherry-pick", "--no-commit", retained);
    const exactTree = git(f.cwd, "write-tree");
    git(f.cwd, "reset", "--hard", firstParent);
    const binding = git(f.cwd, "commit-tree", exactTree,
      "-p", firstParent, "-p", retained,
      "-m", `chore: bind exact adaptation ${retained.slice(0, 12)} for retained`);
    git(f.cwd, "push", "--force", "origin", `${binding}:refs/heads/${branch}`);
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
    assert.deepEqual(report.unsupportedMergeCommits, []);
    assert.deepEqual(report.preservedSyncCommits, [f.maintainer]);
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
        lastResolution: {
          fromTag: "v1.9.0",
          toTag: "v2.0.0",
          originalCommit: f.patch,
          action: "adapt",
          replacementCommit: adapted,
        },
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

test("preserves an authenticated prior-ledger drop without replaying the retired patch", () => {
  const f = fixture();
  try {
    const ledger = {
      ...f.ledger,
      patches: [{
        ...f.ledger.patches[0],
        retiredCommits: [f.patch],
        disposition: "dropped",
        lastResolution: {
          fromTag: "v1.9.0",
          toTag: "v2.0.0",
          originalCommit: f.patch,
          action: "drop",
        },
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
    assert.equal(existsSync(join(f.cwd, "downstream.txt")), false);
    assert.deepEqual(report.appliedPatches, []);
    assert.deepEqual(report.missingLedgerPatches, []);
    assert.equal(report.syncReview.patches[0].resolution.action, "drop");
    assert.equal(report.syncReview.patches[0].resolution.automatic, true);
    assert.equal(report.advancedLedger.patches[0].disposition, "dropped");
    assert.equal(report.manualReview, false);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("applies and binds the exact reviewed adaptation commit into the candidate ancestry", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "-b", "reviewed-adaptation", f.stable);
    const adapted = commitFile(f.cwd, "downstream.txt", "adapted for stable\n", "adapt downstream patch for stable");
    const ledger = {
      ...f.ledger,
      patches: [{...f.ledger.patches[0], files: ["downstream.txt", "stable.txt"]}],
    };
    const unresolved = buildSyncCandidate({
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
    const review = structuredClone(unresolved.syncReview);
    review.patches[0].resolution = {
      action: "adapt",
      commit: adapted,
      automatic: false,
      rationale: "Apply the reviewed stable-based adaptation.",
      tests: ["downstream.test.ts"],
    };
    review.resolved = true;

    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch: "sync/upstream-2.1.0",
      syncRefs: [],
      reviewOverride: review,
      ledger,
      expectedPatchIdentities: f.ledger.patches,
    });

    assert.equal(readFileSync(join(f.cwd, "downstream.txt"), "utf8"), "adapted for stable\n");
    assert.equal(git(f.cwd, "merge-base", "--is-ancestor", adapted, report.exactCandidateCommit), "");
    assert.deepEqual(report.appliedPatches, ["downstream"]);
    assert.deepEqual(report.missingLedgerPatches, []);
    assert.deepEqual(report.appliedAdaptations, [{patch: "downstream", commit: adapted}]);
    assert.equal(report.advancedLedger.patches[0].appliedCommit, adapted);
    assert.equal(report.manualReview, false);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("binds an exact adaptation once so a later reviewed drop cannot replay a duplicate effect", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "-b", "reviewed-adaptation", f.stable);
    const adapted = commitFile(f.cwd, "downstream.txt", "adapted for stable\n", "adapt downstream patch for stable");
    const ledger = {
      ...f.ledger,
      patches: [{...f.ledger.patches[0], files: ["downstream.txt", "stable.txt"]}],
    };
    const unresolved = buildSyncCandidate({
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
    const review = structuredClone(unresolved.syncReview);
    review.patches[0].resolution = {
      action: "adapt",
      commit: adapted,
      automatic: false,
      rationale: "Apply the reviewed stable-based adaptation.",
      tests: ["downstream.test.ts"],
    };
    review.resolved = true;
    const first = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch: "sync/upstream-2.1.0",
      syncRefs: [],
      reviewOverride: review,
      ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    const adaptationEffects = git(f.cwd, "rev-list", "--no-merges", `${f.stable}..${first.exactCandidateCommit}`)
      .split("\n").filter(Boolean)
      .filter((commit) => git(f.cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", commit)
        .split("\n").includes("downstream.txt"));
    assert.deepEqual(adaptationEffects, [adapted]);

    git(f.cwd, "checkout", "upstream");
    commitFile(f.cwd, "next-stable.txt", "next stable\n", "next unrelated stable change");
    git(f.cwd, "tag", "v2.2.0");
    const retained = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.2.0",
      baseRef: "v2.1.0",
      upstreamRef: "upstream",
      alasRef: first.integrationCommit,
      branch: "sync/upstream-2.2.0",
      syncRefs: [],
      ledger: first.advancedLedger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.deepEqual(retained.conflicts, []);
    assert.deepEqual(retained.appliedPatches, ["downstream"]);
    assert.equal(retained.advancedLedger.patches[0].appliedCommit, adapted);

    git(f.cwd, "checkout", "upstream");
    writeFileSync(join(f.cwd, "downstream.txt"), "upstream owns this contract\n");
    git(f.cwd, "add", "downstream.txt");
    git(f.cwd, "commit", "-m", "upstream adopts downstream contract");
    git(f.cwd, "tag", "v2.3.0");
    const nextUnresolved = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.3.0",
      baseRef: "v2.2.0",
      upstreamRef: "upstream",
      alasRef: retained.integrationCommit,
      branch: "sync/upstream-2.3.0",
      syncRefs: [],
      ledger: retained.advancedLedger,
      expectedPatchIdentities: f.ledger.patches,
    });
    const dropReview = structuredClone(nextUnresolved.syncReview);
    dropReview.patches[0].resolution = {
      action: "drop",
      automatic: false,
      rationale: "Upstream now owns the adapted contract.",
      tests: ["downstream.test.ts"],
    };
    dropReview.resolved = true;
    const dropped = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.3.0",
      baseRef: "v2.2.0",
      upstreamRef: "upstream",
      alasRef: retained.integrationCommit,
      branch: "sync/upstream-2.3.0",
      syncRefs: [],
      reviewOverride: dropReview,
      ledger: retained.advancedLedger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.deepEqual(dropped.conflicts, []);
    assert.deepEqual(dropped.appliedPatches, []);
    assert.equal(readFileSync(join(f.cwd, "downstream.txt"), "utf8"), "upstream owns this contract\n");
    assert.equal(dropped.advancedLedger.patches[0].disposition, "dropped");

    git(f.cwd, "checkout", "upstream");
    commitFile(f.cwd, "later-stable.txt", "later stable\n", "later unrelated stable change");
    git(f.cwd, "tag", "v2.4.0");
    const afterDrop = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.4.0",
      baseRef: "v2.3.0",
      upstreamRef: "upstream",
      alasRef: dropped.integrationCommit,
      branch: "sync/upstream-2.4.0",
      syncRefs: [],
      ledger: dropped.advancedLedger,
      expectedPatchIdentities: f.ledger.patches,
    });
    assert.deepEqual(afterDrop.conflicts, []);
    assert.deepEqual(afterDrop.appliedPatches, []);
    assert.equal(readFileSync(join(f.cwd, "downstream.txt"), "utf8"), "upstream owns this contract\n");
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("fails closed when an approved adaptation cannot be tied to a present ledger patch", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "-b", "alas-missing", f.base);
    commitFile(f.cwd, "maintenance-only.txt", "maintenance\n", "maintenance without functional patch");
    git(f.cwd, "checkout", "-b", "reviewed-adaptation", f.stable);
    const adapted = commitFile(f.cwd, "downstream.txt", "adapted for stable\n", "adapt downstream patch for stable");
    const ledger = {
      ...f.ledger,
      patches: [{...f.ledger.patches[0], files: ["downstream.txt", "stable.txt"]}],
    };
    const unresolved = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas-missing",
      branch: "sync/upstream-2.1.0",
      syncRefs: [],
      ledger,
      expectedPatchIdentities: f.ledger.patches,
    });
    const review = structuredClone(unresolved.syncReview);
    review.patches[0].resolution = {
      action: "adapt",
      commit: adapted,
      automatic: false,
      rationale: "Apply the reviewed stable-based adaptation.",
      tests: ["downstream.test.ts"],
    };
    review.resolved = true;

    const report = buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas-missing",
      branch: "sync/upstream-2.1.0",
      syncRefs: [],
      reviewOverride: review,
      ledger,
      expectedPatchIdentities: f.ledger.patches,
    });

    assert.deepEqual(report.appliedPatches, []);
    assert.deepEqual(report.missingLedgerPatches, ["downstream"]);
    assert.ok(report.manualReviewReasons.includes("missing-ledger-patches"));
    assert.equal(report.manualReview, true);
    assert.equal(report.advancedLedger.patches[0].appliedCommit, undefined);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects an adaptation whose ancestry contains an unrelated or stale commit", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "-b", "stacked-adaptation", f.stable);
    commitFile(f.cwd, "unrelated.txt", "unrelated\n", "unrelated ancestor");
    const adapted = commitFile(f.cwd, "downstream.txt", "adapted for stable\n", "adapt downstream patch for stable");
    const ledger = {
      ...f.ledger,
      patches: [{...f.ledger.patches[0], files: ["downstream.txt", "stable.txt"]}],
    };
    const unresolved = buildSyncCandidate({
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
    const review = structuredClone(unresolved.syncReview);
    review.patches[0].resolution = {
      action: "adapt",
      commit: adapted,
      automatic: false,
      rationale: "Attempt to authorize a stacked adaptation.",
      tests: ["downstream.test.ts"],
    };
    review.resolved = true;

    assert.throws(() => buildSyncCandidate({
      cwd: f.cwd,
      tagRef: "v2.1.0",
      baseRef: "v2.0.0",
      upstreamRef: "upstream",
      alasRef: "alas",
      branch: "sync/upstream-2.1.0",
      syncRefs: [],
      reviewOverride: review,
      ledger,
      expectedPatchIdentities: f.ledger.patches,
    }), /adaptation.*directly descend|directly descend.*adaptation/i);
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

function stackedFixture() {
  const root = mkdtempSync(join(tmpdir(), "alas-sync-stacked-"));
  const cwd = join(root, "repo");
  const remote = join(root, "origin.git");
  mkdirSync(cwd);
  git(cwd, "init", "--bare", remote);
  git(cwd, "init", "-b", "upstream", cwd);
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  writeFileSync(join(cwd, "shared.txt"), "upstream header\nshared\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "old stable");
  const base = git(cwd, "rev-parse", "HEAD");
  git(cwd, "tag", "v2.0.0");
  git(cwd, "checkout", "-b", "alas", base);
  const first = commitFile(cwd, "shared.txt", "upstream header\nshared\nfirst\n", "first downstream patch");
  const second = commitFile(cwd, "shared.txt", "upstream header\nshared\nfirst\nsecond\n", "second downstream patch");
  commitFile(cwd, "maintenance.txt", "fork maintenance\n", "downstream maintenance");
  git(cwd, "checkout", "upstream");
  const stable = commitFile(cwd, "shared.txt", "new upstream header\nshared\n", "new stable");
  git(cwd, "tag", "v2.1.0");
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "origin", "alas");
  const ledger = {
    schemaVersion: 2,
    baseTag: "v2.0.0",
    patches: [
      {name: "first", commit: first, upstreamPr: null, files: ["shared.txt"], tests: ["shared.test.ts"]},
      {name: "second", commit: second, upstreamPr: null, files: ["shared.txt"], tests: ["shared.test.ts"]},
    ],
  };
  return {root, cwd, remote, stable, first, second, ledger};
}

function buildStacked(f, options = {}) {
  return buildSyncCandidate({
    cwd: f.cwd,
    tagRef: "v2.1.0",
    baseRef: "v2.0.0",
    upstreamRef: "upstream",
    alasRef: "alas",
    branch: "sync/upstream-2.1.0",
    syncRefs: [],
    ledger: f.ledger,
    expectedPatchIdentities: f.ledger.patches,
    ...options,
  });
}

function manualResolution(action, extra = {}) {
  return {
    action,
    ...extra,
    automatic: false,
    rationale: `Reviewed ${action} for the new stable header.`,
    tests: ["shared.test.ts"],
  };
}

// Retains the first patch, then stacks the reviewed adaptation of the second patch on the exact
// candidate commit that binds the first one.
function stackedResolution(f) {
  const unresolved = buildStacked(f);
  const partial = structuredClone(unresolved.syncReview);
  partial.patches[0].resolution = manualResolution("retain");
  const firstBound = buildStacked(f, {reviewOverride: partial});
  const binding = git(f.cwd, "rev-list", "--reverse", "--first-parent",
    `${f.stable}..${firstBound.exactCandidateCommit}`).split("\n")[0];
  assert.equal(git(f.cwd, "rev-parse", `${binding}^2`), f.first);
  git(f.cwd, "checkout", "--detach", binding);
  const adapted = commitFile(f.cwd, "shared.txt", "new upstream header\nshared\nfirst\nsecond adapted\n",
    "adapt second downstream patch");
  const review = structuredClone(unresolved.syncReview);
  review.patches[0].resolution = manualResolution("retain");
  review.patches[1].resolution = manualResolution("adapt", {commit: adapted});
  review.resolved = true;
  return {unresolved, binding, adapted, review};
}

test("binds an adaptation stacked on the exact candidate commit it is applied to", () => {
  const f = stackedFixture();
  try {
    const {adapted, review} = stackedResolution(f);
    const report = buildStacked(f, {reviewOverride: review});
    assert.equal(report.manualReview, false);
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.appliedPatches, ["first", "second"]);
    assert.deepEqual(report.appliedAdaptations, [{patch: "second", commit: adapted}]);
    assert.equal(git(f.cwd, "merge-base", "--is-ancestor", adapted, report.exactCandidateCommit), "");
    assert.equal(git(f.cwd, "show", `${report.exactCandidateCommit}:shared.txt`),
      "new upstream header\nshared\nfirst\nsecond adapted");
    assert.equal(report.advancedLedger.patches[1].appliedCommit, adapted);

    const repeated = buildStacked(f, {reviewOverride: review});
    assert.equal(repeated.exactCandidateCommit, report.exactCandidateCommit);
    assert.equal(repeated.integrationCommit, report.integrationCommit);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("rejects a stacked adaptation whose parent is not the exact candidate commit it is applied to", () => {
  const f = stackedFixture();
  try {
    const {binding, review} = stackedResolution(f);
    // A sibling of the binding has the same tree but is not the deterministic candidate commit.
    const sibling = git(f.cwd, "commit-tree", `${binding}^{tree}`, "-p", f.stable, "-m", "lookalike binding");
    git(f.cwd, "checkout", "--detach", sibling);
    const misplaced = commitFile(f.cwd, "shared.txt", "new upstream header\nshared\nfirst\nsecond adapted\n",
      "adapt second downstream patch on a lookalike");
    review.patches[1].resolution = manualResolution("adapt", {commit: misplaced});
    assert.throws(() => buildStacked(f, {reviewOverride: review}), /directly descend/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("reruns on its own canonical integration without rewriting it", () => {
  const f = stackedFixture();
  try {
    const branch = "sync/upstream-2.1.0";
    const {review} = stackedResolution(f);
    const resolved = buildStacked(f, {reviewOverride: review});
    pushSyncCandidate({cwd: f.cwd, branch, expectedRemoteSha: "", ref: resolved.integrationCommit});
    git(f.cwd, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);

    const rerun = buildStacked(f, {syncRefs: [`origin/${branch}`]});
    assert.equal(rerun.canonicalHead, null);
    assert.deepEqual(rerun.unsupportedMergeCommits, []);
    assert.equal(rerun.manualReview, false);
    assert.equal(rerun.exactCandidateCommit, resolved.exactCandidateCommit);
    assert.equal(rerun.integrationCommit, resolved.integrationCommit);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

test("applies resolutions recorded in a review-only commit on the canonical branch", () => {
  const f = stackedFixture();
  try {
    const branch = "sync/upstream-2.1.0";
    const {unresolved, review} = stackedResolution(f);
    const resolved = buildStacked(f, {reviewOverride: review});
    pushSyncCandidate({cwd: f.cwd, branch, expectedRemoteSha: "", ref: unresolved.integrationCommit});

    git(f.cwd, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    git(f.cwd, "checkout", "--detach", `origin/${branch}`);
    const recorded = commitFile(f.cwd, "docs/alas-sync-review.json", `${JSON.stringify(review, null, 2)}\n`,
      "docs: resolve v2.1.0 sync review");
    git(f.cwd, "push", "origin", `${recorded}:refs/heads/${branch}`);
    git(f.cwd, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);

    const rerun = buildStacked(f, {syncRefs: [`origin/${branch}`]});
    assert.equal(rerun.syncReviewError, null);
    assert.equal(rerun.canonicalHead, null);
    assert.deepEqual(rerun.preservedSyncCommits, []);
    assert.equal(rerun.manualReview, false);
    assert.deepEqual(rerun.syncReview, resolved.syncReview);
    assert.equal(rerun.integrationCommit, resolved.integrationCommit);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
}, 60_000);

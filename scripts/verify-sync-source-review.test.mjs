import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "vitest";
import {buildSyncCandidate} from "./sync-candidate.mjs";
import {
  verifyReconstructedPatchState,
  verifySyncSourceReview,
} from "./verify-sync-source-review.mjs";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

function commitFile(cwd, path, contents, message) {
  const full = join(cwd, path);
  mkdirSync(join(full, ".."), {recursive: true});
  writeFileSync(full, contents);
  git(cwd, "add", path);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function fixture({preservedCount = 1, reviewOnlyCanonicalCommit = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), "verify-sync-source-"));
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  git(cwd, "init", "-b", "upstream");
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  writeFileSync(join(cwd, "package.json"), '{"version":"1.0.0"}\n');
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "old stable");
  const base = git(cwd, "rev-parse", "HEAD");
  git(cwd, "tag", "v1.0.0");

  git(cwd, "checkout", "-b", "alas", base);
  const patch = commitFile(cwd, "downstream.txt", "downstream\n", "downstream patch");
  const expectedPatchIdentities = [{name: "downstream", commit: patch}];
  const previousLedger = {
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
  commitFile(cwd, "docs/alas-downstream-patches.json", `${JSON.stringify(previousLedger, null, 2)}\n`, "record ledger");
  const previousAlas = git(cwd, "rev-parse", "HEAD");

  git(cwd, "checkout", "upstream");
  writeFileSync(join(cwd, "package.json"), '{"version":"1.1.0"}\n');
  const stable = commitFile(cwd, "stable.txt", "stable\n", "new stable");
  git(cwd, "tag", "v1.1.0");

  git(cwd, "checkout", "-b", "canonical", previousAlas);
  const preserved = [commitFile(cwd, "manual-1.txt", "one\n", "first canonical edit")];
  if (preservedCount > 1) {
    preserved.push(commitFile(cwd, "manual-2.txt", "two\n", "second canonical edit"));
  }
  let reviewOnlyCommit = null;
  if (reviewOnlyCanonicalCommit) {
    reviewOnlyCommit = commitFile(cwd, "docs/alas-sync-review.json", "{}\n", "review-only metadata");
  }

  const unresolved = buildSyncCandidate({
    cwd,
    tagRef: "v1.1.0",
    baseRef: "v1.0.0",
    upstreamRef: "upstream",
    alasRef: "alas",
    branch: "sync/upstream-1.1.0",
    syncRefs: ["canonical"],
    canonicalSyncRef: "canonical",
    ledger: previousLedger,
    expectedPatchIdentities,
  });
  const review = structuredClone(unresolved.syncReview);
  for (const entry of review.preservedCommits) {
    entry.resolution = {
      action: "retain",
      automatic: false,
      rationale: "Reviewed canonical edit.",
      tests: ["npm run test:maintenance"],
    };
  }
  review.resolved = true;

  const final = buildSyncCandidate({
    cwd,
    tagRef: "v1.1.0",
    baseRef: "v1.0.0",
    upstreamRef: "upstream",
    alasRef: "alas",
    branch: "sync/upstream-1.1.0",
    syncRefs: ["canonical"],
    canonicalSyncRef: "canonical",
    reviewOverride: review,
    ledger: previousLedger,
    expectedPatchIdentities,
  });
  git(cwd, "branch", "alas-source", final.integrationCommit);
  return {
    root,
    cwd,
    base,
    stable,
    patch,
    previousAlas,
    previousLedger,
    expectedPatchIdentities,
    preserved,
    reviewOnlyCommit,
    review: final.syncReview,
    ledger: final.advancedLedger,
    sourceCommit: final.integrationCommit,
    exactCandidateCommit: final.exactCandidateCommit,
  };
}

function verify(f, overrides = {}) {
  return verifySyncSourceReview({
    cwd: f.cwd,
    sourceCommit: f.sourceCommit,
    alasRef: "alas-source",
    upstreamTag: "v1.1.0",
    upstreamMainRef: "upstream",
    packageVersion: "1.1.0",
    review: f.review,
    ledger: f.ledger,
    expectedPatchIdentities: f.expectedPatchIdentities,
    ...overrides,
  });
}

test("independently reconstructs the exact reviewed source tree, ledger transition, and preserved history", () => {
  const f = fixture();
  try {
    const result = verify(f);
    assert.equal(result.integrationCommit, f.sourceCommit);
    assert.equal(result.exactCandidateCommit, f.exactCandidateCommit);
    assert.equal(result.reconstructedCandidateCommit, f.exactCandidateCommit);
    assert.equal(result.reconstructedIntegrationCommit, f.sourceCommit);
    assert.deepEqual(result.preservedCommits, f.preserved);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("accepts a tree-identical normal protected-branch merge wrapper around the exact reviewed integration", () => {
  const f = fixture();
  try {
    const wrapper = git(f.cwd, "commit-tree", `${f.sourceCommit}^{tree}`,
      "-p", f.previousAlas, "-p", f.sourceCommit, "-m", "Merge pull request #42");
    git(f.cwd, "branch", "alas-wrapper", wrapper);
    const result = verify(f, {sourceCommit: wrapper, alasRef: "alas-wrapper"});
    assert.equal(result.sourceCommit, wrapper);
    assert.equal(result.integrationCommit, f.sourceCommit);
    assert.equal(result.reconstructedIntegrationCommit, f.sourceCommit);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("binds the review canonical head to the last canonical commit that contributes preserved history", () => {
  const f = fixture({reviewOnlyCanonicalCommit: true});
  try {
    // A trailing review-only commit is read as the previous review; it is not a provenance parent.
    assert.equal(f.review.canonicalHead, f.preserved.at(-1));
    assert.deepEqual(f.review.preservedCommits.map(({commit}) => commit), f.preserved);
    const result = verify(f);
    assert.equal(result.canonicalHead, f.preserved.at(-1));
    assert.deepEqual(result.preservedCommits, f.preserved);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects omitted, added, reordered, arbitrary-ancestor, and review-only preserved metadata", () => {
  const f = fixture({preservedCount: 2, reviewOnlyCanonicalCommit: true});
  try {
    const arbitraryAncestor = f.patch;
    const reviewOnly = f.reviewOnlyCommit;
    const cases = [
      {...f.review, preservedCommits: f.review.preservedCommits.slice(1)},
      {...f.review, preservedCommits: [...f.review.preservedCommits, {
        commit: arbitraryAncestor,
        subject: "downstream patch",
        constituentCommits: [],
        resolution: f.review.preservedCommits[0].resolution,
      }]},
      {...f.review, preservedCommits: [...f.review.preservedCommits].reverse()},
      {...f.review, preservedCommits: [...f.review.preservedCommits, {
        commit: reviewOnly,
        subject: "review-only metadata",
        constituentCommits: [],
        resolution: f.review.preservedCommits[0].resolution,
      }]},
    ];
    for (const review of cases) {
      assert.throws(() => verify(f, {review}), /canonical|preserved|metadata|committed source artifact/i);
    }
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects forged ledger state not exactly derived from the first-parent prior ledger", () => {
  const f = fixture();
  try {
    for (const ledger of [
      {...f.ledger, inventedState: {approved: true}},
      {...f.ledger, patches: [...f.ledger.patches, {...f.ledger.patches[0], name: "invented"}]},
      {...f.ledger, retiredCommits: ["f".repeat(40)]},
    ]) {
      assert.throws(() => verify(f, {ledger}), /ledger.*exact|exact.*ledger|known functional patch/i);
    }
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects a stale integration and any unreviewed source tree change", () => {
  const f = fixture();
  try {
    git(f.cwd, "checkout", "-B", "post-source", f.sourceCommit);
    const post = commitFile(f.cwd, "unreviewed.txt", "unreviewed\n", "unreviewed post-integration change");
    git(f.cwd, "branch", "alas-post", post);
    assert.throws(() => verify(f, {sourceCommit: post, alasRef: "alas-post"}), /reviewed protected integration/i);

    const staleReview = {...f.review, toCommit: f.base};
    assert.throws(() => verify(f, {review: staleReview}), /target|toCommit|review/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("rejects a same-tree integration that substitutes an unreviewed exact candidate commit", () => {
  const f = fixture();
  try {
    const candidateParent = git(f.cwd, "rev-parse", `${f.exactCandidateCommit}^1`);
    const alternateCandidate = git(f.cwd, "commit-tree", `${f.exactCandidateCommit}^{tree}`,
      "-p", candidateParent, "-m", "forged same-tree exact candidate");
    const parents = ["-p", f.previousAlas, "-p", alternateCandidate];
    if (f.review.canonicalHead) parents.push("-p", f.review.canonicalHead);
    const forgedIntegration = git(f.cwd, "commit-tree", `${f.sourceCommit}^{tree}`,
      ...parents, "-m", `chore: integrate exact upstream ${f.stable.slice(0, 12)}`);
    git(f.cwd, "branch", "alas-forged-integration", forgedIntegration);
    assert.throws(() => verify(f, {
      sourceCommit: forgedIntegration,
      alasRef: "alas-forged-integration",
    }), /exact candidate ancestry|integration commit/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("independently rejects adaptation ledger state when the exact adaptation is absent from candidate ancestry", () => {
  const f = fixture();
  try {
    const adaptation = f.preserved[0];
    const review = structuredClone(f.review);
    review.patches[0].resolution = {
      action: "adapt",
      commit: adaptation,
      automatic: false,
      rationale: "Reviewed adaptation.",
      tests: ["downstream.test.ts"],
    };
    const ledger = structuredClone(f.ledger);
    ledger.patches[0].appliedCommit = adaptation;
    ledger.patches[0].disposition = "active";
    assert.throws(() => verifyReconstructedPatchState({
      cwd: f.cwd,
      reconstructed: {
        appliedPatches: ["downstream"],
        appliedAdaptations: [{patch: "downstream", commit: adaptation}],
        missingLedgerPatches: [],
        manualReview: false,
        exactCandidateCommit: f.exactCandidateCommit,
        preservedSyncCommits: f.preserved,
        appliedPreservedAdaptations: [],
      },
      review,
      ledger,
    }), /adaptation.*ancestry|ancestry.*adaptation/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("independently rejects a retained applied commit absent from exact candidate ancestry", () => {
  const f = fixture();
  try {
    const applied = f.preserved[0];
    const review = structuredClone(f.review);
    review.patches[0].commit = applied;
    review.patches[0].appliedCommit = applied;
    review.patches[0].resolution = {
      action: "retain",
      automatic: false,
      rationale: "Retain the authenticated prior adaptation.",
      tests: ["downstream.test.ts"],
    };
    const ledger = structuredClone(f.ledger);
    ledger.patches[0].appliedCommit = applied;
    ledger.patches[0].disposition = "active";
    assert.throws(() => verifyReconstructedPatchState({
      cwd: f.cwd,
      reconstructed: {
        appliedPatches: ["downstream"],
        appliedAdaptations: [],
        missingLedgerPatches: [],
        manualReview: false,
        exactCandidateCommit: f.exactCandidateCommit,
        preservedSyncCommits: f.preserved,
        appliedPreservedAdaptations: [],
      },
      review,
      ledger,
    }), /retained.*ancestry|ancestry.*retained/i);
  } finally {
    rmSync(f.root, {recursive: true, force: true});
  }
});

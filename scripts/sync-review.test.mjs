import assert from "node:assert/strict";
import {test} from "vitest";
import {
  advancePatchLedger,
  createSyncReview,
  verifySyncReviewArtifact,
  verifyPatchLedgerTransition,
} from "./sync-review.mjs";
import {validatePatchLedger} from "./downstream-patches.mjs";

const toCommit = "a".repeat(40);
const classifications = [
  {
    name: "unaffected-patch",
    commit: "1".repeat(40),
    patchId: "b".repeat(40),
    classification: "unaffected",
    overlappingFiles: [],
    tests: ["unaffected.test.ts"],
  },
  {
    name: "overlap-patch",
    commit: "2".repeat(40),
    patchId: "c".repeat(40),
    classification: "overlap",
    overlappingFiles: ["src/contract.ts"],
    tests: ["overlap.test.ts"],
  },
];

test("auto-resolves only unaffected patches and leaves overlap unresolved", () => {
  const review = createSyncReview({
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications,
  });
  assert.equal(review.schemaVersion, 2);
  assert.equal(review.canonicalHead, null);
  assert.deepEqual(review.preservedCommits, []);
  assert.equal(review.resolved, false);
  assert.deepEqual(review.patches[0].resolution, {
    action: "retain",
    automatic: true,
    rationale: "No equivalent or overlapping upstream stable change was detected.",
    tests: ["unaffected.test.ts"],
  });
  assert.deepEqual(review.patches[1].resolution, {
    action: null,
    automatic: false,
    rationale: "",
    tests: [],
  });
  assert.throws(() => verifySyncReviewArtifact({
    review,
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications,
  }), /unresolved.*overlap-patch/i);
});

test("requires the exact canonical head and complete ordered preserved commit metadata", () => {
  const preservedCommits = [
    {commit: "3".repeat(40), subject: "first review edit", constituentCommits: []},
    {commit: "4".repeat(40), subject: "review merge", constituentCommits: ["5".repeat(40)]},
  ];
  const review = createSyncReview({
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications: [classifications[0]],
    canonicalHead: "4".repeat(40),
    preservedCommits,
  });
  for (const entry of review.preservedCommits) {
    entry.resolution = {
      action: "retain",
      automatic: false,
      rationale: "Reviewed canonical same-version edit.",
      tests: ["npm run test:maintenance"],
    };
  }
  review.resolved = true;
  assert.deepEqual(verifySyncReviewArtifact({
    review,
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications: [classifications[0]],
    canonicalHead: "4".repeat(40),
    preservedCommits,
  }), review);

  for (const tampered of [
    {...review, canonicalHead: "6".repeat(40)},
    {...review, preservedCommits: review.preservedCommits.slice(1)},
    {...review, preservedCommits: [...review.preservedCommits].reverse()},
    {...review, preservedCommits: [...review.preservedCommits, {
      commit: "7".repeat(40),
      subject: "invented ancestor",
      constituentCommits: [],
      resolution: review.preservedCommits[0].resolution,
    }]},
  ]) {
    assert.throws(() => verifySyncReviewArtifact({
      review: tampered,
      fromTag: "v2.1.0",
      toTag: "v2.2.0",
      toCommit,
      classifications: [classifications[0]],
      canonicalHead: "4".repeat(40),
      preservedCommits,
    }), /canonicalHead|preserved/i);
  }
});

test("derives the exact committed ledger transition from the previous ledger and review", () => {
  const previousLedger = {
    schemaVersion: 2,
    baseTag: "v2.1.0",
    patches: classifications.map(({name, commit, tests}) => ({
      name,
      commit,
      upstreamPr: null,
      files: [`${name}.ts`],
      tests,
    })),
    retiredCommits: [],
    preservedTransitions: [],
  };
  const review = createSyncReview({
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications,
  });
  review.patches[1].resolution = {
    action: "drop",
    automatic: false,
    rationale: "Upstream now owns this contract.",
    tests: ["overlap.test.ts"],
  };
  review.resolved = true;
  const advanced = advancePatchLedger({ledger: previousLedger, review});
  assert.equal(advanced.baseTag, "v2.2.0");
  assert.equal(advanced.patches[1].disposition, "dropped");
  assert.deepEqual(advanced.patches[1].retiredCommits, [classifications[1].commit]);
  assert.equal(verifyPatchLedgerTransition({
    ledger: advanced,
    previousLedger,
    review,
    expectedPatchIdentities: classifications,
  }), true);
  for (const tampered of [
    {...advanced, inventedState: true},
    {...advanced, patches: advanced.patches.slice(0, 1)},
    {...advanced, retiredCommits: ["8".repeat(40)]},
  ]) {
    assert.throws(() => verifyPatchLedgerTransition({
      ledger: tampered,
      previousLedger,
      review,
      expectedPatchIdentities: classifications,
    }), /exact.*transition|transition.*exact/i);
  }
});

test("retain preserves the authenticated adaptation transition for the active applied commit", () => {
  const original = "1".repeat(40);
  const applied = "2".repeat(40);
  const previousLedger = {
    schemaVersion: 2,
    baseTag: "v2.1.0",
    patches: [{
      name: "adapted-patch",
      commit: original,
      appliedCommit: applied,
      upstreamPr: null,
      files: ["adapted-patch.ts"],
      tests: ["adapted-patch.test.ts"],
      disposition: "active",
      retiredCommits: [original],
      lastResolution: {
        fromTag: "v2.0.0",
        toTag: "v2.1.0",
        originalCommit: original,
        action: "adapt",
        replacementCommit: applied,
      },
    }],
    retiredCommits: [],
    preservedTransitions: [],
  };
  const review = createSyncReview({
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications: [{
      ...previousLedger.patches[0],
      originalCommit: original,
      commit: applied,
      patchId: "a".repeat(40),
      classification: "unaffected",
      overlappingFiles: [],
    }],
  });
  const advanced = advancePatchLedger({ledger: previousLedger, review});
  assert.deepEqual(advanced.patches[0].lastResolution, previousLedger.patches[0].lastResolution);
  assert.deepEqual(
    validatePatchLedger(advanced, {expectedPatchIdentities: [{name: "adapted-patch", commit: original}]}),
    advanced,
  );
});

test("accepts explicit retain adapt or drop resolutions with rationale and tests", () => {
  for (const action of ["retain", "adapt", "drop"]) {
    const review = createSyncReview({
      fromTag: "v2.1.0",
      toTag: "v2.2.0",
      toCommit,
      classifications,
    });
    review.patches[1].resolution = {
      action,
      ...(action === "adapt" ? {commit: "9".repeat(40)} : {}),
      automatic: false,
      rationale: `${action} after semantic review of the changed contract.`,
      tests: ["overlap.test.ts"],
    };
    review.resolved = true;
    assert.deepEqual(verifySyncReviewArtifact({
      review,
      fromTag: "v2.1.0",
      toTag: "v2.2.0",
      toCommit,
      classifications,
    }), review);
  }
});

test("rejects stale metadata, recomputed classification mismatch, and incomplete manual resolutions", () => {
  const resolved = createSyncReview({
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications,
  });
  resolved.patches[1].resolution = {
    action: "retain",
    automatic: false,
    rationale: "Reviewed against the stable implementation.",
    tests: ["overlap.test.ts"],
  };
  resolved.resolved = true;
  assert.throws(() => verifySyncReviewArtifact({
    review: {...resolved, toCommit: "d".repeat(40)},
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications,
  }), /toCommit/i);
  assert.throws(() => verifySyncReviewArtifact({
    review: resolved,
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications: classifications.map((patch) => patch.name === "overlap-patch"
      ? {...patch, classification: "absorbed", overlappingFiles: []}
      : patch),
  }), /classification.*overlap-patch/i);
  resolved.patches[1].resolution.rationale = "";
  assert.throws(() => verifySyncReviewArtifact({
    review: resolved,
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications,
  }), /rationale.*overlap-patch/i);
  resolved.patches[1].resolution.rationale = "Reviewed against the stable implementation.";
  assert.throws(() => verifySyncReviewArtifact({
    review: {...resolved, fromTag: "main"},
    fromTag: "main",
    toTag: "v2.2.0",
    toCommit,
    classifications,
  }), /fromTag.*stable/i);
});

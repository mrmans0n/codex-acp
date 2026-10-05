import assert from "node:assert/strict";
import {test} from "vitest";
import {
  createSyncReview,
  verifySyncReviewArtifact,
} from "./sync-review.mjs";

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
      automatic: false,
      rationale: `${action} after semantic review of the changed contract.`,
      tests: ["overlap.test.ts"],
    };
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

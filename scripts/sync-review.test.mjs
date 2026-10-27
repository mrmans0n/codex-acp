import assert from "node:assert/strict";
import {test} from "vitest";
import {
  advancePatchLedger,
  createSyncReview,
  verifySyncReviewArtifact,
  verifyPatchLedgerTransition,
  workflowChangesResolved,
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

test("carries reviewed resolutions to a new canonical head of the same stable transition", () => {
  const resolution = {
    action: "adapt",
    commit: "8".repeat(40),
    automatic: false,
    rationale: "Adapted to the new stable contract.",
    tests: ["overlap.test.ts"],
  };
  const recorded = createSyncReview({
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications,
    canonicalHead: "4".repeat(40),
  });
  recorded.patches[1].resolution = resolution;

  // The maintainer commit that records the resolution becomes the new canonical branch head.
  const rerun = createSyncReview({
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications,
    canonicalHead: null,
    previousReview: recorded,
  });
  assert.equal(rerun.canonicalHead, null);
  assert.deepEqual(rerun.patches[1].resolution, resolution);
  assert.equal(rerun.resolved, true);
  assert.deepEqual(verifySyncReviewArtifact({
    review: rerun,
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications,
  }), rerun);

  for (const previousReview of [
    {...recorded, toTag: "v2.2.1"},
    {...recorded, toCommit: "9".repeat(40)},
    {...recorded, patches: recorded.patches.map((patch, index) => index === 1
      ? {...patch, overlappingFiles: ["src/other.ts"]}
      : patch)},
  ]) {
    const stale = createSyncReview({
      fromTag: "v2.1.0",
      toTag: "v2.2.0",
      toCommit,
      classifications,
      previousReview,
    });
    assert.equal(stale.patches[1].resolution.action, null);
    assert.equal(stale.resolved, false);
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

const workflowResolution = {
  action: "retain-downstream",
  automatic: false,
  rationale: "Upstream CI change mirrored into alas by a separate automation PR after the sync.",
  tests: ["scripts/sync-upstream.test.mjs"],
};
const workflowChanges = [".github/workflows/ci.yml", ".github/workflows/e2e.yml"];

function workflowReview(previousReview = null) {
  return createSyncReview({
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications: [classifications[0]],
    workflowChanges,
    previousReview,
  });
}

test("lists every upstream workflow change as unresolved until each has an explicit reviewed resolution", () => {
  const review = workflowReview();
  assert.deepEqual(review.upstreamWorkflowChanges.map(({path}) => path), workflowChanges);
  assert.equal(review.resolved, false);
  assert.equal(workflowChangesResolved(review, workflowChanges), false);
  const verify = (candidate, changes = workflowChanges) => verifySyncReviewArtifact({
    review: candidate,
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications: [classifications[0]],
    workflowChanges: changes,
  });
  assert.throws(() => verify(review), /unresolved upstream workflow change/i);

  const resolved = workflowReview({
    ...review,
    upstreamWorkflowChanges: review.upstreamWorkflowChanges.map((entry) => ({...entry, resolution: workflowResolution})),
  });
  assert.equal(resolved.resolved, true);
  assert.equal(workflowChangesResolved(resolved, workflowChanges), true);
  assert.deepEqual(verify(resolved), resolved);

  // An unlisted change, an invented one, a reordered list, or a list for a transition without workflow
  // changes never verifies.
  const [first, second] = resolved.upstreamWorkflowChanges;
  for (const [tampered, changes] of [
    [{...resolved, upstreamWorkflowChanges: [first]}, workflowChanges],
    [{...resolved, upstreamWorkflowChanges: [first, second, {...first, path: ".github/workflows/invented.yml"}]}, workflowChanges],
    [{...resolved, upstreamWorkflowChanges: [second, first]}, workflowChanges],
    [resolved, []],
  ]) {
    assert.throws(() => verify(tampered, changes), /workflow/i);
  }

  // Only an explicit manual retain-downstream resolution with rationale and tests is accepted.
  for (const resolution of [
    {...workflowResolution, action: "retain"},
    {...workflowResolution, action: "adapt"},
    {...workflowResolution, automatic: true},
    {...workflowResolution, rationale: " "},
    {...workflowResolution, tests: []},
  ]) {
    const tampered = {
      ...resolved,
      upstreamWorkflowChanges: [first, {...second, resolution}],
      resolved: false,
    };
    assert.equal(workflowChangesResolved(tampered, workflowChanges), false);
    assert.throws(() => verify(tampered), /unresolved upstream workflow change/i);
  }

  // A previous resolution for a path outside this transition's delta is not carried over.
  const unrelated = workflowReview({
    ...review,
    upstreamWorkflowChanges: [{path: ".github/workflows/other.yml", resolution: workflowResolution}],
  });
  assert.equal(unrelated.resolved, false);
});

test("omits workflow and downstream sections when the transition has none", () => {
  const review = createSyncReview({fromTag: "v2.1.0", toTag: "v2.2.0", toCommit, classifications: [classifications[0]]});
  assert.equal(Object.hasOwn(review, "upstreamWorkflowChanges"), false);
  assert.equal(Object.hasOwn(review, "downstreamCommits"), false);
  assert.deepEqual(Object.keys(review), [
    "schemaVersion", "fromTag", "toTag", "toCommit", "canonicalHead", "patches", "preservedCommits", "resolved",
  ]);
});

const downstreamIdentity = {
  commit: "8".repeat(40),
  subject: "build: prepare downstream package metadata",
  patchId: "9".repeat(40),
  equivalentCommits: ["d".repeat(40)],
};
const downstreamResolution = {
  action: "adapt",
  commit: "e".repeat(40),
  automatic: false,
  rationale: "Reviewed adaptation of the package metadata to the new stable manifest.",
  tests: ["scripts/prepare-alas-package.test.mjs"],
};

function downstreamReview(previousEntries) {
  return createSyncReview({
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications: [classifications[0]],
    downstreamCommits: [downstreamIdentity],
    previousReview: {
      schemaVersion: 2,
      fromTag: "v2.1.0",
      toTag: "v2.2.0",
      toCommit,
      downstreamCommits: previousEntries,
    },
  });
}

test("carries a non-ledger adaptation only for the exact recomputed downstream identity", () => {
  const review = downstreamReview([{...downstreamIdentity, resolution: downstreamResolution}]);
  assert.equal(review.resolved, true);
  assert.deepEqual(review.downstreamCommits, [{...downstreamIdentity, resolution: downstreamResolution}]);
  const verify = (candidate) => verifySyncReviewArtifact({
    review: candidate,
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    toCommit,
    classifications: [classifications[0]],
  });
  assert.deepEqual(verify(review), review);

  for (const previous of [
    {...downstreamIdentity, equivalentCommits: []},
    {...downstreamIdentity, subject: "another commit"},
    {...downstreamIdentity, patchId: "f".repeat(40)},
  ]) {
    const reset = downstreamReview([{...previous, resolution: downstreamResolution}]);
    assert.equal(reset.resolved, false);
    assert.equal(reset.downstreamCommits[0].resolution.action, null);
    assert.throws(() => verify(reset), /unresolved downstream commit/i);
  }

  for (const resolution of [
    {...downstreamResolution, action: "retain"},
    {...downstreamResolution, action: "drop"},
    {...downstreamResolution, commit: "short"},
    {...downstreamResolution, automatic: true},
    {...downstreamResolution, rationale: ""},
    {...downstreamResolution, tests: []},
  ]) {
    const tampered = {...review, downstreamCommits: [{...review.downstreamCommits[0], resolution}], resolved: false};
    assert.throws(() => verify(tampered), /unresolved downstream commit/i);
  }
  for (const tampered of [
    {...review, downstreamCommits: []},
    {...review, downstreamCommits: [review.downstreamCommits[0], review.downstreamCommits[0]]},
    {...review, downstreamCommits: [{...review.downstreamCommits[0], patchId: null}]},
  ]) {
    assert.throws(() => verify(tampered), /downstream/i);
  }
});

test("retires an adapted non-ledger commit with its equivalents and records the transition", () => {
  const previousLedger = {
    schemaVersion: 2,
    baseTag: "v2.1.0",
    patches: [{
      name: "unaffected-patch",
      commit: "1".repeat(40),
      upstreamPr: null,
      files: ["unaffected.ts"],
      tests: ["unaffected.test.ts"],
    }],
    retiredCommits: [],
    preservedTransitions: [],
  };
  const review = downstreamReview([{...downstreamIdentity, resolution: downstreamResolution}]);
  const advanced = advancePatchLedger({ledger: previousLedger, review});
  assert.deepEqual(advanced.retiredCommits, [downstreamIdentity.commit, ...downstreamIdentity.equivalentCommits]);
  assert.deepEqual(advanced.downstreamTransitions, [{
    fromTag: "v2.1.0",
    toTag: "v2.2.0",
    ...downstreamIdentity,
    action: "adapt",
    replacementCommit: downstreamResolution.commit,
  }]);
  assert.doesNotThrow(() => verifyPatchLedgerTransition({ledger: advanced, previousLedger, review}));
  assert.throws(() => verifyPatchLedgerTransition({
    ledger: {...advanced, retiredCommits: [downstreamIdentity.commit]},
    previousLedger,
    review,
  }), /exactly match/i);

  // Without non-ledger adaptations the ledger keeps its existing shape.
  const plain = createSyncReview({fromTag: "v2.1.0", toTag: "v2.2.0", toCommit, classifications: [classifications[0]]});
  assert.equal(Object.hasOwn(advancePatchLedger({ledger: previousLedger, review: plain}), "downstreamTransitions"), false);
});

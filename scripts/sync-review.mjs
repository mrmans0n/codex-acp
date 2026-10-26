const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MANUAL_ACTIONS = new Set(["retain", "adapt", "drop"]);

function assertTag(value, field) {
  if (!STABLE_TAG.test(String(value ?? ""))) throw new Error(`${field} must be a stable vX.Y.Z tag`);
}

function classificationRecord(patch) {
  return {
    name: patch.name,
    commit: patch.commit,
    patchId: patch.patchId,
    classification: patch.classification,
    overlappingFiles: [...patch.overlappingFiles],
  };
}

function sameClassification(left, right) {
  return left?.name === right.name &&
    left?.commit === right.commit &&
    left?.patchId === right.patchId &&
    left?.classification === right.classification &&
    JSON.stringify(left?.overlappingFiles) === JSON.stringify(right.overlappingFiles);
}

function automaticResolution(patch) {
  return {
    action: "retain",
    automatic: true,
    rationale: "No equivalent or overlapping upstream stable change was detected.",
    tests: [...patch.tests],
  };
}

function unresolvedResolution() {
  return {action: null, automatic: false, rationale: "", tests: []};
}

export function createSyncReview({fromTag, toTag, toCommit, classifications, previousReview = null}) {
  assertTag(fromTag, "fromTag");
  assertTag(toTag, "toTag");
  if (!FULL_COMMIT.test(String(toCommit ?? ""))) throw new Error("toCommit must be a full commit SHA");
  if (!Array.isArray(classifications) || classifications.length === 0) {
    throw new Error("classifications must be a non-empty array");
  }
  const sameReview = previousReview?.schemaVersion === 1 &&
    previousReview.fromTag === fromTag && previousReview.toTag === toTag && previousReview.toCommit === toCommit;
  const previousByName = new Map(sameReview
    ? previousReview.patches.map((patch) => [patch.name, patch])
    : []);
  return {
    schemaVersion: 1,
    fromTag,
    toTag,
    toCommit,
    patches: classifications.map((patch) => {
      const record = classificationRecord(patch);
      if (patch.classification === "unaffected") {
        return {...record, resolution: automaticResolution(patch)};
      }
      const previous = previousByName.get(patch.name);
      const resolution = previous && sameClassification(previous, record)
        ? previous.resolution
        : unresolvedResolution();
      return {...record, resolution};
    }),
  };
}

export function verifySyncReviewArtifact({review, fromTag, toTag, toCommit, classifications}) {
  assertTag(fromTag, "fromTag");
  assertTag(toTag, "toTag");
  if (!FULL_COMMIT.test(String(toCommit ?? ""))) throw new Error("toCommit must be a full commit SHA");
  if (review?.schemaVersion !== 1) throw new Error("sync review schemaVersion must be 1");
  if (review.fromTag !== fromTag) throw new Error(`sync review fromTag mismatch: ${review.fromTag}`);
  if (review.toTag !== toTag) throw new Error(`sync review toTag mismatch: ${review.toTag}`);
  if (review.toCommit !== toCommit) throw new Error(`sync review toCommit mismatch: ${review.toCommit}`);
  if (!Array.isArray(review.patches) || review.patches.length !== classifications.length) {
    throw new Error("sync review patch count does not match recomputed classifications");
  }
  for (let index = 0; index < classifications.length; index += 1) {
    const expected = classificationRecord(classifications[index]);
    const actual = review.patches[index];
    if (!sameClassification(actual, expected)) {
      throw new Error(`sync review classification mismatch for ${expected.name}`);
    }
    const resolution = actual.resolution;
    if (expected.classification === "unaffected") {
      const automatic = automaticResolution(classifications[index]);
      if (JSON.stringify(resolution) !== JSON.stringify(automatic)) {
        throw new Error(`unaffected patch ${expected.name} must use the automatic retain resolution`);
      }
      continue;
    }
    if (!MANUAL_ACTIONS.has(resolution?.action) || resolution.automatic !== false) {
      throw new Error(`unresolved ${expected.classification} patch ${expected.name}: choose retain, adapt, or drop`);
    }
    if (typeof resolution.rationale !== "string" || resolution.rationale.trim() === "") {
      throw new Error(`rationale is required for ${expected.name}`);
    }
    if (!Array.isArray(resolution.tests) || resolution.tests.length === 0 ||
        resolution.tests.some((path) => typeof path !== "string" || path.trim() === "")) {
      throw new Error(`tests are required for ${expected.name}`);
    }
  }
  return review;
}

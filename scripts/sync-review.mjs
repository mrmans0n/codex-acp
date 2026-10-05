import {isDeepStrictEqual} from "node:util";

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MANUAL_ACTIONS = new Set(["retain", "adapt", "drop"]);

function assertTag(value, field) {
  if (!STABLE_TAG.test(String(value ?? ""))) throw new Error(`${field} must be a stable vX.Y.Z tag`);
}

function assertCommitOrNull(value, field) {
  if (!(value === null || FULL_COMMIT.test(String(value ?? "")))) {
    throw new Error(`${field} must be null or a full commit SHA`);
  }
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

function preservedIdentity(entry) {
  return {
    commit: entry.commit,
    subject: entry.subject,
    constituentCommits: [...(entry.constituentCommits ?? [])],
  };
}

function samePreservedIdentity(left, right) {
  return isDeepStrictEqual(preservedIdentity(left), preservedIdentity(right));
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

function manualResolutionValid(resolution) {
  return MANUAL_ACTIONS.has(resolution?.action) &&
    (resolution.action !== "adapt" || FULL_COMMIT.test(String(resolution.commit ?? ""))) &&
    resolution.automatic === false &&
    typeof resolution.rationale === "string" && resolution.rationale.trim() !== "" &&
    Array.isArray(resolution.tests) && resolution.tests.length > 0 &&
    resolution.tests.every((path) => typeof path === "string" && path.trim() !== "");
}

function reviewResolved(review) {
  return review.patches.every((patch) => patch.classification === "unaffected"
    ? patch.resolution?.action === "retain" &&
      patch.resolution?.automatic === true &&
      patch.resolution?.rationale === "No equivalent or overlapping upstream stable change was detected." &&
      Array.isArray(patch.resolution?.tests) && patch.resolution.tests.length > 0
    : manualResolutionValid(patch.resolution)) &&
    review.preservedCommits.every((entry) => manualResolutionValid(entry.resolution));
}

export function createSyncReview({
  fromTag,
  toTag,
  toCommit,
  classifications,
  canonicalHead = null,
  preservedCommits = [],
  previousReview = null,
}) {
  assertTag(fromTag, "fromTag");
  assertTag(toTag, "toTag");
  if (!FULL_COMMIT.test(String(toCommit ?? ""))) throw new Error("toCommit must be a full commit SHA");
  assertCommitOrNull(canonicalHead, "canonicalHead");
  if (!Array.isArray(classifications) || classifications.length === 0) {
    throw new Error("classifications must be a non-empty array");
  }
  if (!Array.isArray(preservedCommits)) throw new Error("preservedCommits must be an array");
  const sameReview = previousReview?.schemaVersion === 2 &&
    previousReview.fromTag === fromTag && previousReview.toTag === toTag &&
    previousReview.toCommit === toCommit && previousReview.canonicalHead === canonicalHead;
  const previousByName = new Map(sameReview
    ? (previousReview.patches ?? []).map((patch) => [patch.name, patch])
    : []);
  const previousPreserved = new Map(sameReview
    ? (previousReview.preservedCommits ?? []).map((entry) => [entry.commit, entry])
    : []);
  const review = {
    schemaVersion: 2,
    fromTag,
    toTag,
    toCommit,
    canonicalHead,
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
    preservedCommits: preservedCommits.map((entry) => {
      const identity = preservedIdentity(entry);
      const previous = previousPreserved.get(entry.commit);
      return {
        ...identity,
        resolution: previous && samePreservedIdentity(previous, identity)
          ? previous.resolution
          : unresolvedResolution(),
      };
    }),
    resolved: false,
  };
  review.resolved = reviewResolved(review);
  return review;
}

export function verifySyncReviewArtifact({
  review,
  fromTag,
  toTag,
  toCommit,
  classifications,
  canonicalHead = null,
  preservedCommits = [],
}) {
  assertTag(fromTag, "fromTag");
  assertTag(toTag, "toTag");
  if (!FULL_COMMIT.test(String(toCommit ?? ""))) throw new Error("toCommit must be a full commit SHA");
  assertCommitOrNull(canonicalHead, "canonicalHead");
  if (review?.schemaVersion !== 2) throw new Error("sync review schemaVersion must be 2");
  if (review.fromTag !== fromTag) throw new Error(`sync review fromTag mismatch: ${review.fromTag}`);
  if (review.toTag !== toTag) throw new Error(`sync review toTag mismatch: ${review.toTag}`);
  if (review.toCommit !== toCommit) throw new Error(`sync review toCommit mismatch: ${review.toCommit}`);
  if (review.canonicalHead !== canonicalHead) {
    throw new Error(`sync review canonicalHead mismatch: ${review.canonicalHead}`);
  }
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
      if (!isDeepStrictEqual(resolution, automatic)) {
        throw new Error(`unaffected patch ${expected.name} must use the automatic retain resolution`);
      }
      continue;
    }
    if (!MANUAL_ACTIONS.has(resolution?.action) || resolution.automatic !== false) {
      throw new Error(`unresolved ${expected.classification} patch ${expected.name}: choose retain, adapt, or drop`);
    }
    if (resolution.action === "adapt" && !FULL_COMMIT.test(String(resolution.commit ?? ""))) {
      throw new Error(`adapt resolution commit is required for ${expected.name}`);
    }
    if (typeof resolution.rationale !== "string" || resolution.rationale.trim() === "") {
      throw new Error(`rationale is required for ${expected.name}`);
    }
    if (!Array.isArray(resolution.tests) || resolution.tests.length === 0 ||
        resolution.tests.some((path) => typeof path !== "string" || path.trim() === "")) {
      throw new Error(`tests are required for ${expected.name}`);
    }
  }
  const expectedPreserved = preservedCommits.map(preservedIdentity);
  const actualPreserved = Array.isArray(review.preservedCommits)
    ? review.preservedCommits.map(preservedIdentity)
    : null;
  if (!isDeepStrictEqual(actualPreserved, expectedPreserved)) {
    throw new Error("sync review preserved commit metadata does not exactly match canonical history");
  }
  for (const entry of review.preservedCommits) {
    if (!manualResolutionValid(entry.resolution)) {
      throw new Error(`unresolved preserved commit ${entry.commit}: choose retain, adapt, or drop with rationale and tests`);
    }
  }
  const resolved = reviewResolved(review);
  if (Object.hasOwn(review, "resolved") && review.resolved !== resolved) {
    throw new Error("sync review resolved flag does not match its resolutions");
  }
  if (!resolved) throw new Error("sync review contains unresolved manual-review items");
  return review;
}

function patchTransition(review, patch) {
  return {
    fromTag: review.fromTag,
    toTag: review.toTag,
    originalCommit: patch.commit,
    action: patch.resolution.action,
    ...(patch.resolution.action === "adapt" ? {replacementCommit: patch.resolution.commit} : {}),
  };
}

function preservedTransition(review, entry) {
  return {
    fromTag: review.fromTag,
    toTag: review.toTag,
    commit: entry.commit,
    subject: entry.subject,
    constituentCommits: [...(entry.constituentCommits ?? [])],
    action: entry.resolution.action,
    ...(entry.resolution.action === "adapt" ? {replacementCommit: entry.resolution.commit} : {}),
  };
}

export function advancePatchLedger({ledger, review}) {
  if (!reviewResolved(review)) throw new Error("Cannot advance patch ledger from an unresolved sync review");
  if (ledger?.baseTag === review.toTag) return structuredClone(ledger);
  if (ledger?.baseTag !== review.fromTag) {
    throw new Error(`Patch ledger baseTag ${ledger?.baseTag} does not match review fromTag ${review.fromTag}`);
  }
  const reviewed = new Map(review.patches.map((patch) => [patch.name, patch]));
  const patches = ledger.patches.map((patch) => {
    const item = reviewed.get(patch.name);
    const currentCommit = patch.appliedCommit ?? patch.commit;
    if (!item || item.commit !== currentCommit) {
      throw new Error(`Patch ledger does not contain reviewed commit ${item?.commit ?? patch.name}`);
    }
    const retiredCommits = [...new Set(patch.retiredCommits ?? [])];
    const result = {...patch, lastResolution: patchTransition(review, item)};
    if (item.resolution.action === "drop") {
      retiredCommits.push(currentCommit);
      delete result.appliedCommit;
      result.disposition = "dropped";
    } else if (item.resolution.action === "adapt") {
      retiredCommits.push(currentCommit);
      result.appliedCommit = item.resolution.commit;
      result.disposition = "active";
    } else {
      result.disposition = "active";
    }
    result.retiredCommits = [...new Set(retiredCommits)];
    return result;
  });
  const preservedTransitions = [
    ...(ledger.preservedTransitions ?? []).filter((entry) => entry.toTag !== review.toTag),
    ...review.preservedCommits.map((entry) => preservedTransition(review, entry)),
  ];
  const retiredCommits = [...new Set([
    ...(ledger.retiredCommits ?? []),
    ...review.preservedCommits
      .filter((entry) => ["drop", "adapt"].includes(entry.resolution.action))
      .flatMap((entry) => [entry.commit, ...(entry.constituentCommits ?? [])]),
  ])];
  return {
    ...structuredClone(ledger),
    baseTag: review.toTag,
    patches,
    retiredCommits,
    preservedTransitions,
  };
}

export function verifyPatchLedgerTransition({
  ledger,
  previousLedger,
  review,
  expectedPatchIdentities,
}) {
  const expected = advancePatchLedger({ledger: previousLedger, review});
  if (!isDeepStrictEqual(ledger, expected)) {
    throw new Error("Committed patch ledger does not exactly match the transition derived from prior source history");
  }
  if (expectedPatchIdentities) {
    const expectedIdentities = expectedPatchIdentities.map(({name, commit}) => ({name, commit}));
    const actualIdentities = ledger.patches.map(({name, commit}) => ({name, commit}));
    if (!isDeepStrictEqual(actualIdentities, expectedIdentities)) {
      throw new Error("Committed patch ledger does not exactly match the anchored functional patch identities");
    }
  }
  return true;
}

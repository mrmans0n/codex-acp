import {execFileSync, spawnSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {isDeepStrictEqual} from "node:util";
import {
  classifyDownstreamPatches,
  KNOWN_PATCH_IDENTITIES,
  validatePatchLedger,
} from "./downstream-patches.mjs";
import {
  buildSyncCandidate,
  discoverCanonicalPreservedCommits,
} from "./sync-candidate.mjs";
import {
  verifyPatchLedgerTransition,
  verifySyncReviewArtifact,
} from "./sync-review.mjs";
import {verifyAlasSource} from "./verify-alas-source.mjs";

const REVIEW_PATH = "docs/alas-sync-review.json";
const LEDGER_PATH = "docs/alas-downstream-patches.json";

function git(cwd, ...args) {
  return execFileSync("git", args, {cwd, encoding: "utf8", stdio: "pipe"}).trim();
}

function readJsonAt(cwd, commit, path, label) {
  let contents;
  try {
    contents = git(cwd, "show", `${commit}:${path}`);
  } catch {
    throw new Error(`Cannot read ${label} from ${commit}:${path}`);
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label} at ${commit}:${path} is not valid JSON`);
  }
}

function preservedIdentity(entry) {
  return {
    commit: entry.commit,
    subject: entry.subject,
    constituentCommits: [...(entry.constituentCommits ?? [])],
  };
}

function verifyCommittedArtifacts(cwd, sourceCommit, review, ledger) {
  const committedReview = readJsonAt(cwd, sourceCommit, REVIEW_PATH, "committed sync review");
  const committedLedger = readJsonAt(cwd, sourceCommit, LEDGER_PATH, "committed patch ledger");
  if (!isDeepStrictEqual(review, committedReview)) {
    throw new Error("Provided sync review does not exactly match the committed source artifact");
  }
  if (!isDeepStrictEqual(ledger, committedLedger)) {
    throw new Error("Provided patch ledger does not exactly match the committed source artifact");
  }
}

function verifySourceTree(cwd, sourceCommit, candidateCommit) {
  const sourceTree = git(cwd, "rev-parse", `${sourceCommit}^{tree}`);
  const candidateTree = git(cwd, "rev-parse", `${candidateCommit}^{tree}`);
  if (sourceTree !== candidateTree) {
    throw new Error("Publication source tree does not match the independently reconstructed reviewed candidate");
  }
}

function isAncestor(cwd, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr || `Cannot compare ${ancestor} with ${descendant}`);
}

export function verifyReconstructedPatchState({cwd, reconstructed, review, ledger}) {
  if (reconstructed.manualReview || reconstructed.missingLedgerPatches.length > 0) {
    throw new Error("Independently reconstructed candidate still requires manual review or has missing ledger patches");
  }
  const ledgerByName = new Map(ledger.patches.map((patch) => [patch.name, patch]));
  const expectedAppliedPatches = review.patches
    .filter((patch) => ["retain", "adapt"].includes(patch.resolution.action))
    .map((patch) => patch.name);
  if (!isDeepStrictEqual(reconstructed.appliedPatches, expectedAppliedPatches)) {
    throw new Error("Reconstructed appliedPatches do not exactly match committed review resolutions");
  }
  const expectedAdaptations = review.patches
    .filter((patch) => patch.resolution.action === "adapt")
    .map((patch) => ({patch: patch.name, commit: patch.resolution.commit}));
  if (!isDeepStrictEqual(reconstructed.appliedAdaptations, expectedAdaptations)) {
    throw new Error("Reconstructed adaptations do not exactly match committed review resolutions");
  }
  const expectedPreservedCommits = review.preservedCommits
    .filter((entry) => ["retain", "adapt"].includes(entry.resolution.action))
    .map((entry) => entry.resolution.action === "adapt" ? entry.resolution.commit : entry.commit);
  if (!isDeepStrictEqual(reconstructed.preservedSyncCommits, expectedPreservedCommits)) {
    throw new Error("Reconstructed preserved commits do not exactly match committed review resolutions");
  }
  const expectedPreservedAdaptations = review.preservedCommits
    .filter((entry) => entry.resolution.action === "adapt")
    .map((entry) => ({commit: entry.commit, replacementCommit: entry.resolution.commit}));
  if (!isDeepStrictEqual(reconstructed.appliedPreservedAdaptations, expectedPreservedAdaptations)) {
    throw new Error("Reconstructed preserved adaptations do not exactly match committed review resolutions");
  }
  for (const patch of review.patches) {
    const ledgerPatch = ledgerByName.get(patch.name);
    if (!ledgerPatch) throw new Error(`Committed ledger is missing reviewed patch ${patch.name}`);
    if (patch.resolution.action === "adapt") {
      if (ledgerPatch.appliedCommit !== patch.resolution.commit || ledgerPatch.disposition !== "active") {
        throw new Error(`Committed ledger adaptation for ${patch.name} does not match the exact reviewed commit`);
      }
      if (!isAncestor(cwd, patch.resolution.commit, reconstructed.exactCandidateCommit)) {
        throw new Error(`Exact adaptation ${patch.resolution.commit} for ${patch.name} is absent from candidate ancestry`);
      }
    } else if (patch.resolution.action === "drop") {
      if (ledgerPatch.disposition !== "dropped" || ledgerPatch.appliedCommit !== undefined) {
        throw new Error(`Committed ledger drop for ${patch.name} does not match the reviewed resolution`);
      }
    } else {
      const retainedCommit = ledgerPatch.appliedCommit ?? ledgerPatch.commit;
      if (ledgerPatch.disposition !== "active" || patch.commit !== retainedCommit) {
        throw new Error(`Committed ledger retain for ${patch.name} does not match the exact reviewed commit`);
      }
      if (!isAncestor(cwd, retainedCommit, reconstructed.exactCandidateCommit)) {
        throw new Error(`Exact retained commit ${retainedCommit} for ${patch.name} is absent from candidate ancestry`);
      }
    }
  }
  for (const entry of review.preservedCommits) {
    if (entry.resolution.action === "adapt" &&
        !isAncestor(cwd, entry.resolution.commit, reconstructed.exactCandidateCommit)) {
      throw new Error(`Exact preserved adaptation ${entry.resolution.commit} is absent from candidate ancestry`);
    }
  }
  return true;
}

export function verifySyncSourceReview({
  cwd,
  sourceCommit,
  alasRef,
  upstreamTag,
  upstreamMainRef,
  packageVersion,
  review,
  ledger,
  expectedPatchIdentities = KNOWN_PATCH_IDENTITIES,
}) {
  const source = verifyAlasSource({
    cwd,
    sourceCommit,
    alasRef,
    upstreamTag,
    upstreamMainRef,
    packageVersion,
  });
  verifyCommittedArtifacts(cwd, source.sourceCommit, review, ledger);
  validatePatchLedger(ledger, {expectedPatchIdentities});

  const previousLedger = readJsonAt(cwd, source.previousAlas, LEDGER_PATH, "previous patch ledger");
  validatePatchLedger(previousLedger, {expectedPatchIdentities});
  if (previousLedger.baseTag !== source.reviewBaseTag) {
    throw new Error(`Previous patch ledger baseTag ${previousLedger.baseTag} does not match derived review base ${source.reviewBaseTag}`);
  }

  const preservedCommits = source.canonicalHead
    ? discoverCanonicalPreservedCommits({
      cwd,
      canonicalRef: source.canonicalHead,
      alasRef: source.previousAlas,
      upstreamRef: upstreamMainRef,
      targetCommit: source.upstreamCommit,
      reviewPath: REVIEW_PATH,
      ledgerPath: LEDGER_PATH,
    })
    : [];
  const canonicalHead = source.canonicalHead;
  const expectedPreserved = preservedCommits.map(preservedIdentity);
  const actualPreserved = (review.preservedCommits ?? []).map(preservedIdentity);
  if (!isDeepStrictEqual(actualPreserved, expectedPreserved)) {
    throw new Error("Sync review canonical preserved metadata does not exactly match verified source history");
  }

  const classifications = classifyDownstreamPatches({
    cwd,
    ledger: previousLedger,
    baseRef: source.reviewBaseTag,
    targetRef: upstreamTag,
    expectedPatchIdentities,
  });
  verifySyncReviewArtifact({
    review,
    fromTag: source.reviewBaseTag,
    toTag: upstreamTag,
    toCommit: source.upstreamCommit,
    classifications,
    canonicalHead,
    preservedCommits,
  });
  verifyPatchLedgerTransition({
    ledger,
    previousLedger,
    review,
    expectedPatchIdentities,
  });

  const root = mkdtempSync(join(tmpdir(), "verify-sync-source-"));
  const worktree = join(root, "worktree");
  const branch = `verify-sync-source-${process.pid}-${basename(root)}`;
  let reconstructed;
  try {
    git(cwd, "worktree", "add", "--detach", worktree, source.upstreamCommit);
    reconstructed = buildSyncCandidate({
      cwd: worktree,
      tagRef: source.upstreamCommit,
      baseRef: source.reviewBaseTag,
      upstreamRef: upstreamMainRef,
      alasRef: source.previousAlas,
      branch,
      syncRefs: source.canonicalHead ? [source.canonicalHead] : [],
      canonicalSyncRef: source.canonicalHead,
      reviewOverride: review,
      ledger: previousLedger,
      expectedPatchIdentities,
      fromTag: source.reviewBaseTag,
      toTag: upstreamTag,
      reviewPath: REVIEW_PATH,
      ledgerPath: LEDGER_PATH,
    });
    if (!isDeepStrictEqual(reconstructed.syncReview, review)) {
      throw new Error("Committed sync review does not match the independently reconstructed review transition");
    }
    if (!isDeepStrictEqual(reconstructed.advancedLedger, ledger)) {
      throw new Error("Committed patch ledger does not match the independently reconstructed ledger transition");
    }
    verifyReconstructedPatchState({cwd, reconstructed, review, ledger});
    if (reconstructed.exactCandidateCommit !== source.exactCandidateCommit) {
      throw new Error("Publication source exact candidate ancestry does not match independent reconstruction");
    }
    if (reconstructed.integrationCommit !== source.integrationCommit) {
      throw new Error("Publication source integration commit does not match independent reconstruction");
    }
    verifySourceTree(cwd, source.sourceCommit, reconstructed.exactCandidateCommit);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], {cwd, encoding: "utf8"});
    spawnSync("git", ["branch", "-D", branch], {cwd, encoding: "utf8"});
    spawnSync("git", ["branch", "-D", `${branch}-exact`], {cwd, encoding: "utf8"});
    rmSync(root, {recursive: true, force: true});
  }

  return {
    ...source,
    reconstructedCandidateCommit: reconstructed.exactCandidateCommit,
    reconstructedIntegrationCommit: reconstructed.integrationCommit,
    preservedCommits: preservedCommits.map((entry) => entry.commit),
  };
}

#!/usr/bin/env node

import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import {
  classifyDownstreamPatches,
  KNOWN_PATCH_IDENTITIES,
  validatePatchLedger,
} from "./downstream-patches.mjs";
import {
  advancePatchLedger,
  createSyncReview,
  verifySyncReviewArtifact,
} from "./sync-review.mjs";

const BOT_IDENTITY = {
  GIT_AUTHOR_NAME: "github-actions[bot]",
  GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "github-actions[bot]",
  GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
};

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
    env: options.env,
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
}

function deterministicCommitEnv(cwd, commit) {
  const date = git(cwd, ["show", "-s", "--format=%cI", commit]);
  return {...process.env, ...BOT_IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date};
}

function lines(value) {
  return value.split("\n").filter(Boolean);
}

function patchId(cwd, commit) {
  const patch = git(cwd, ["show", "--pretty=format:", "--binary", commit]);
  if (!patch) return null;
  return git(cwd, ["patch-id", "--stable"], {input: `${patch}\n`}).split(/\s+/)[0] || null;
}

function patchIdCommits(cwd, ref) {
  const result = new Map();
  for (const commit of lines(git(cwd, ["rev-list", "--reverse", "--no-merges", ref]))) {
    const id = patchId(cwd, commit);
    if (id && !result.has(id)) result.set(id, commit);
  }
  return result;
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

function cherryPick(cwd, commit) {
  const parents = git(cwd, ["show", "-s", "--format=%P", commit]).split(/\s+/).filter(Boolean);
  const args = ["cherry-pick", ...(parents.length > 1 ? ["-m", "1"] : []), commit];
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: deterministicCommitEnv(cwd, commit),
  });
  if (result.status === 0) return true;
  spawnSync("git", ["cherry-pick", "--abort"], {cwd, encoding: "utf8", stdio: "pipe"});
  return false;
}

function commitsBetween(cwd, base, head) {
  return lines(git(cwd, ["rev-list", "--reverse", "--no-merges", `${base}..${head}`]));
}

function tagName(ref) {
  const name = String(ref).split("/").at(-1);
  if (!/^v\d+\.\d+\.\d+$/.test(name)) throw new Error(`Cannot derive stable tag name from ${ref}`);
  return name;
}

function readReviewAtRef(cwd, ref, reviewPath) {
  const result = spawnSync("git", ["show", `${ref}:${reviewPath}`], {cwd, encoding: "utf8", stdio: "pipe"});
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

function writeSyncArtifacts(cwd, reviewPath, review, ledgerPath, ledger) {
  let changed = false;
  for (const [path, value] of [[reviewPath, review], [ledgerPath, ledger]]) {
    const fullPath = `${cwd}/${path}`;
    mkdirSync(dirname(fullPath), {recursive: true});
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    if (!existsSync(fullPath) || readFileSync(fullPath, "utf8") !== contents) {
      writeFileSync(fullPath, contents);
      git(cwd, ["add", path]);
      changed = true;
    }
  }
  if (!changed) return false;
  git(cwd, ["commit", "-m", `chore: record sync review ${review.toTag}`], {
    env: deterministicCommitEnv(cwd, review.toCommit),
  });
  return true;
}

function isGeneratedReviewCommit(cwd, commit, reviewPath, toTag) {
  const subject = git(cwd, ["show", "-s", "--format=%s", commit]);
  const paths = lines(git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]));
  return subject === `chore: record sync review ${toTag}` &&
    paths.length === 1 && paths[0] === reviewPath;
}

function isReviewOnlyCommit(cwd, commit, reviewPath, ledgerPath) {
  const paths = lines(git(cwd, ["diff", "--name-only", `${commit}^1`, commit]));
  const allowed = new Set([reviewPath, ledgerPath]);
  return paths.length > 0 && paths.every((path) => allowed.has(path));
}

function commitSummary(cwd, commit) {
  const parents = git(cwd, ["show", "-s", "--format=%P", commit]).split(/\s+/).filter(Boolean);
  return {
    commit,
    subject: git(cwd, ["show", "-s", "--format=%s", commit]),
    constituentCommits: parents.length > 1
      ? lines(git(cwd, ["rev-list", "--reverse", `${commit}^2`, "--not", `${commit}^1`]))
      : [],
  };
}

function isGeneratedIntegrationMerge(cwd, commit, alasRef, upstreamRef, targetCommit) {
  const subject = git(cwd, ["show", "-s", "--format=%s", commit]);
  const parents = git(cwd, ["show", "-s", "--format=%P", commit]).split(/\s+/);
  if (subject !== `chore: integrate exact upstream ${targetCommit.slice(0, 12)}` ||
      parents.length < 2 || parents.length > 3) return false;
  if (parents.length === 3 &&
      (parents[2] === parents[0] || !isAncestor(cwd, parents[0], parents[2]))) return false;
  const alasCommit = git(cwd, ["rev-parse", `${alasRef}^{commit}`]);
  const mergeTree = git(cwd, ["rev-parse", `${commit}^{tree}`]);
  const exactTree = git(cwd, ["rev-parse", `${parents[1]}^{tree}`]);
  return parents[0] === alasCommit && mergeTree === exactTree &&
    git(cwd, ["merge-base", commit, upstreamRef]) === targetCommit;
}

function discoverCanonicalCandidates({
  cwd,
  canonicalRef,
  alasRef,
  upstreamRef,
  targetCommit,
  reviewPath,
  ledgerPath,
  seen = new Set(),
}) {
  const result = [];
  const commits = lines(git(cwd, [
    "rev-list", "--reverse", "--first-parent", canonicalRef, "--not", alasRef, upstreamRef,
  ]));
  for (const commit of commits) {
    if (seen.has(commit)) continue;
    seen.add(commit);
    if (isGeneratedIntegrationMerge(cwd, commit, alasRef, upstreamRef, targetCommit)) {
      const parents = git(cwd, ["show", "-s", "--format=%P", commit]).split(/\s+/).filter(Boolean);
      if (parents[2]) {
        result.push(...discoverCanonicalCandidates({
          cwd,
          canonicalRef: parents[2],
          alasRef,
          upstreamRef,
          targetCommit,
          reviewPath,
          ledgerPath,
          seen,
        }));
      }
      continue;
    }
    if (isReviewOnlyCommit(cwd, commit, reviewPath, ledgerPath)) continue;
    result.push(commit);
  }
  return result;
}

export function discoverCanonicalPreservedCommits(options) {
  return discoverCanonicalCandidates(options).map((commit) => commitSummary(options.cwd, commit));
}

function restoreWorkflowTree(cwd, alasRef, targetCommit) {
  const remove = spawnSync("git", ["rm", "-r", "--ignore-unmatch", ".github/workflows"], {
    cwd, encoding: "utf8", stdio: "pipe",
  });
  if (remove.status !== 0) throw new Error(remove.stderr || "Cannot clear candidate workflow tree");
  const tree = git(cwd, ["ls-tree", "-d", "--name-only", alasRef, ".github/workflows"]);
  if (tree) git(cwd, ["checkout", alasRef, "--", ".github/workflows"]);
  const changed = spawnSync("git", ["diff", "--cached", "--quiet", "--", ".github/workflows"], {
    cwd, encoding: "utf8", stdio: "pipe",
  });
  if (changed.status === 1) {
    git(cwd, ["commit", "-m", "chore: retain downstream workflows for review"], {
      env: deterministicCommitEnv(cwd, targetCommit),
    });
  }
  else if (changed.status !== 0) throw new Error(changed.stderr || "Cannot inspect candidate workflow tree");
}

function assertContaminationContained(cwd, alasRef, upstreamRef, tagCommit) {
  const mergeBases = lines(git(cwd, ["merge-base", "--all", alasRef, upstreamRef]));
  const uncontained = mergeBases.filter((base) => !isAncestor(cwd, base, tagCommit));
  if (uncontained.length > 0) {
    throw new Error(`Upstream contamination not contained by target stable tag ${tagCommit}: ${uncontained.join(", ")}`);
  }
  return mergeBases;
}

function createIntegrationMerge(cwd, {
  branch,
  alasRef,
  exactCandidateCommit,
  tagCommit,
  upstreamRef,
  canonicalHead = null,
}) {
  const alasCommit = git(cwd, ["rev-parse", `${alasRef}^{commit}`]);
  const tree = git(cwd, ["rev-parse", `${exactCandidateCommit}^{tree}`]);
  const parents = ["-p", alasCommit, "-p", exactCandidateCommit];
  if (canonicalHead && canonicalHead !== alasCommit && canonicalHead !== exactCandidateCommit) {
    parents.push("-p", canonicalHead);
  }
  const integrationCommit = git(cwd, [
    "commit-tree", tree, ...parents, "-m", `chore: integrate exact upstream ${tagCommit.slice(0, 12)}`,
  ], {env: deterministicCommitEnv(cwd, tagCommit)});
  git(cwd, ["update-ref", `refs/heads/${branch}`, integrationCommit]);
  git(cwd, ["checkout", branch]);
  const integrationMergeBases = lines(git(cwd, ["merge-base", "--all", integrationCommit, upstreamRef]));
  if (integrationMergeBases.length !== 1 || integrationMergeBases[0] !== tagCommit) {
    throw new Error(`Integration merge-base with upstream main must be exactly ${tagCommit}, got ${integrationMergeBases.join(", ")}`);
  }
  const exactTree = git(cwd, ["rev-parse", `${exactCandidateCommit}^{tree}`]);
  const integrationTree = git(cwd, ["rev-parse", `${integrationCommit}^{tree}`]);
  if (integrationTree !== exactTree) {
    throw new Error(`Integration tree ${integrationTree} does not match exact candidate tree ${exactTree}`);
  }
  return integrationCommit;
}

export function buildSyncCandidate({
  cwd,
  tagRef,
  baseRef,
  upstreamRef,
  alasRef,
  branch,
  syncRefs = [],
  canonicalSyncRef = null,
  reviewOverride = null,
  ledger,
  expectedPatchIdentities = KNOWN_PATCH_IDENTITIES,
  fromTag = tagName(baseRef),
  toTag = tagName(tagRef),
  reviewPath = "docs/alas-sync-review.json",
  ledgerPath = "docs/alas-downstream-patches.json",
}) {
  validatePatchLedger(ledger, {expectedPatchIdentities});
  if (ledger.baseTag !== fromTag) {
    throw new Error(`Patch ledger baseTag ${ledger.baseTag} does not match sync fromTag ${fromTag}`);
  }
  const tagCommit = git(cwd, ["rev-parse", `${tagRef}^{commit}`]);
  const previousMergeBases = assertContaminationContained(cwd, alasRef, upstreamRef, tagCommit);
  const classifications = classifyDownstreamPatches({
    cwd,
    ledger,
    baseRef,
    targetRef: tagRef,
    expectedPatchIdentities,
  });
  const ledgerByPatchId = new Map(classifications.filter((patch) => patch.patchId)
    .map((patch) => [patch.patchId, patch]));
  const retiredCommits = new Set([
    ...(ledger.retiredCommits ?? []),
    ...ledger.patches.flatMap((patch) => patch.retiredCommits ?? []),
  ]);
  const targetPatchIds = patchIdCommits(cwd, tagRef);
  const upstreamPatchIds = patchIdCommits(cwd, upstreamRef);
  const downstreamCommits = commitsBetween(cwd, upstreamRef, alasRef);
  const downstreamPatchIds = new Set(downstreamCommits.map((commit) => patchId(cwd, commit)).filter(Boolean));
  let preserved = [];
  const preservedPatchIds = new Set();
  const syncHeads = [];
  const staleSyncHeads = [];
  const unsupportedMergeCommits = [];
  const canonicalRef = canonicalSyncRef ?? `origin/${branch}`;
  let canonicalHead = null;
  let canonicalSourceHead = null;
  let previousReview = reviewOverride;

  for (const ref of syncRefs) {
    const head = git(cwd, ["rev-parse", `${ref}^{commit}`]);
    syncHeads.push({ref, head});
    const commits = commitsBetween(cwd, alasRef, ref).filter((commit) => !isAncestor(cwd, commit, upstreamRef));
    if (ref !== canonicalRef && ref !== branch) {
      staleSyncHeads.push({ref, head, commits});
      continue;
    }
    canonicalSourceHead = head;
    canonicalHead = head;
    for (const merge of lines(git(cwd, ["rev-list", "--reverse", "--merges", `${alasRef}..${ref}`]))) {
      if (!isGeneratedIntegrationMerge(cwd, merge, alasRef, upstreamRef, tagCommit)) {
        unsupportedMergeCommits.push(merge);
      }
    }
    previousReview ??= readReviewAtRef(cwd, ref, reviewPath);
    preserved = discoverCanonicalPreservedCommits({
      cwd,
      canonicalRef: ref,
      alasRef,
      upstreamRef,
      targetCommit: tagCommit,
      reviewPath,
      ledgerPath,
    });
    preserved = preserved.filter((entry) => {
      const id = patchId(cwd, entry.commit);
      if (id && (downstreamPatchIds.has(id) || preservedPatchIds.has(id))) return false;
      if (id) preservedPatchIds.add(id);
      return true;
    });
  }

  previousReview ??= readReviewAtRef(cwd, alasRef, reviewPath);
  const syncReview = createSyncReview({
    fromTag,
    toTag,
    toCommit: tagCommit,
    classifications,
    canonicalHead,
    preservedCommits: preserved,
    previousReview,
  });
  let syncReviewError = null;
  try {
    verifySyncReviewArtifact({
      review: syncReview,
      fromTag,
      toTag,
      toCommit: tagCommit,
      classifications,
      canonicalHead,
      preservedCommits: preserved,
    });
  } catch (error) {
    syncReviewError = error.message;
  }
  const reviewByName = new Map(syncReview.patches.map((patch) => [patch.name, patch]));
  const preservedReviewByCommit = new Map(syncReview.preservedCommits.map((entry) => [entry.commit, entry]));

  const exactBranch = `${branch}-exact`;
  git(cwd, ["checkout", "-B", exactBranch, tagCommit]);
  const appliedPatches = [];
  const appliedDownstreamCommits = [];
  const appliedSyncCommits = [];
  const excludedUpstreamEquivalents = [];
  const excludedUpstreamLaterEquivalents = [];
  const excludedCanonicalUpstreamEquivalents = [];
  const excludedCanonicalUpstreamLaterEquivalents = [];
  const conflicts = [];
  const seenLedgerPatches = new Set();
  for (const commit of downstreamCommits) {
    const id = patchId(cwd, commit);
    const patch = id ? ledgerByPatchId.get(id) : undefined;
    if (retiredCommits.has(commit) && !patch) continue;
    if (patch) {
      seenLedgerPatches.add(patch.name);
      if (patch.classification !== "unaffected" &&
          reviewByName.get(patch.name)?.resolution?.action !== "retain") continue;
    } else if (id && upstreamPatchIds.has(id)) {
      const equivalent = {commit, upstreamCommit: upstreamPatchIds.get(id)};
      if (targetPatchIds.has(id)) excludedUpstreamEquivalents.push(equivalent);
      else excludedUpstreamLaterEquivalents.push(equivalent);
      continue;
    }
    if (!cherryPick(cwd, commit)) {
      conflicts.push({commit, kind: "downstream", ...(patch ? {patch: patch.name} : {})});
      break;
    }
    appliedDownstreamCommits.push(commit);
    if (patch) appliedPatches.push(patch.name);
  }
  if (conflicts.length === 0) {
    for (const entry of preserved) {
      const commit = entry.commit;
      const id = patchId(cwd, commit);
      const patch = id ? ledgerByPatchId.get(id) : undefined;
      if (retiredCommits.has(commit) && !patch) continue;
      if (patch) {
        seenLedgerPatches.add(patch.name);
        if (patch.classification !== "unaffected" &&
            reviewByName.get(patch.name)?.resolution?.action !== "retain") continue;
      } else if (id && upstreamPatchIds.has(id)) {
        const equivalent = {commit, upstreamCommit: upstreamPatchIds.get(id)};
        if (targetPatchIds.has(id)) excludedCanonicalUpstreamEquivalents.push(equivalent);
        else excludedCanonicalUpstreamLaterEquivalents.push(equivalent);
        continue;
      }
      const resolution = preservedReviewByCommit.get(commit)?.resolution;
      if (resolution?.action === "drop") continue;
      const selectedCommit = resolution?.action === "adapt" ? resolution.commit : commit;
      if (!cherryPick(cwd, selectedCommit)) {
        conflicts.push({commit, kind: "canonical-sync-review", ...(patch ? {patch: patch.name} : {})});
        break;
      }
      appliedSyncCommits.push(commit);
    }
  }
  const missingLedgerPatches = classifications
    .filter((patch) => patch.classification === "unaffected" && !seenLedgerPatches.has(patch.name))
    .map((patch) => patch.name);

  const workflowChanges = lines(git(cwd, ["diff", "--name-only", baseRef, tagRef, "--", ".github/workflows"]));
  if (workflowChanges.length > 0) restoreWorkflowTree(cwd, alasRef, tagCommit);
  const advancedLedger = syncReviewError ? ledger : advancePatchLedger({ledger, review: syncReview});
  writeSyncArtifacts(cwd, reviewPath, syncReview, ledgerPath, advancedLedger);
  const exactCandidateCommit = git(cwd, ["rev-parse", "HEAD"]);
  const exactMergeBase = git(cwd, ["merge-base", exactCandidateCommit, upstreamRef]);
  if (exactMergeBase !== tagCommit) {
    throw new Error(`Exact candidate merge-base ${exactMergeBase} is not stable tag ${tagCommit}`);
  }
  const integrationCommit = createIntegrationMerge(cwd, {
    branch,
    alasRef,
    exactCandidateCommit,
    tagCommit,
    upstreamRef,
    canonicalHead: canonicalSourceHead,
  });

  const manualReviewReasons = [];
  if (syncReviewError) manualReviewReasons.push("sync-review-unresolved");
  if (workflowChanges.length > 0) manualReviewReasons.push("upstream-workflow-changes");
  if (conflicts.length > 0) manualReviewReasons.push("cherry-pick-conflicts");
  if (missingLedgerPatches.length > 0) manualReviewReasons.push("missing-ledger-patches");
  if (unsupportedMergeCommits.length > 0) manualReviewReasons.push("canonical-sync-merge-commits");
  if (appliedSyncCommits.length > 0) manualReviewReasons.push("preserved-canonical-sync-commits");
  if (excludedCanonicalUpstreamEquivalents.length > 0) {
    manualReviewReasons.push("excluded-canonical-sync-upstream-equivalents");
  }
  if (excludedCanonicalUpstreamLaterEquivalents.length > 0) {
    manualReviewReasons.push("excluded-canonical-sync-upstream-later-equivalents");
  }

  return {
    tagCommit,
    exactBranch,
    exactCandidateCommit,
    integrationCommit,
    candidateCommit: integrationCommit,
    previousMergeBases,
    classifications,
    appliedPatches,
    appliedDownstreamCommits,
    excludedUpstreamEquivalents,
    excludedUpstreamLaterEquivalents,
    excludedCanonicalUpstreamEquivalents,
    excludedCanonicalUpstreamLaterEquivalents,
    syncReview,
    advancedLedger,
    canonicalHead,
    canonicalSourceHead,
    syncReviewError,
    missingLedgerPatches,
    preservedSyncCommits: appliedSyncCommits,
    syncHeads,
    staleSyncHeads,
    workflowChanges,
    conflicts,
    unsupportedMergeCommits,
    manualReviewReasons,
    manualReview: manualReviewReasons.length > 0,
  };
}

export function verifyRemoteSyncHeads({cwd, syncHeads, remote = "origin"}) {
  return syncHeads.flatMap(({ref, head: expected}) => {
    const prefix = `${remote}/`;
    if (!ref.startsWith(prefix)) throw new Error(`sync ref must start with ${prefix}: ${ref}`);
    const branch = ref.slice(prefix.length);
    const output = git(cwd, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
    const actual = output.split(/\s+/)[0] || null;
    return actual === expected ? [] : [{branch, expected, actual}];
  });
}

export function pushSyncCandidate({cwd, branch, expectedRemoteSha = "", remote = "origin", ref = "HEAD"}) {
  if (branch === "alas" || branch === "refs/heads/alas") {
    throw new Error("Refusing to push a sync candidate directly to protected alas");
  }
  if (!branch.startsWith("sync/")) {
    throw new Error(`Refusing to force-update branch outside the owned sync namespace: ${branch}`);
  }
  const lease = `--force-with-lease=refs/heads/${branch}:${expectedRemoteSha}`;
  try {
    git(cwd, ["push", lease, remote, `${ref}:refs/heads/${branch}`]);
  } catch (error) {
    throw new Error(String(error.stderr || error.message));
  }
  return git(cwd, ["rev-parse", ref]);
}

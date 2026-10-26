#!/usr/bin/env node

import {execFileSync, spawnSync} from "node:child_process";
import {classifyDownstreamPatches, validatePatchLedger} from "./downstream-patches.mjs";

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
}

function patchId(cwd, commit) {
  const patch = git(cwd, ["show", "--pretty=format:", "--binary", commit]);
  if (!patch) return null;
  return git(cwd, ["patch-id", "--stable"], {input: `${patch}\n`}).split(/\s+/)[0] || null;
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
  const result = spawnSync("git", ["cherry-pick", commit], {cwd, encoding: "utf8", stdio: "pipe"});
  if (result.status === 0) return true;
  spawnSync("git", ["cherry-pick", "--abort"], {cwd, encoding: "utf8", stdio: "pipe"});
  return false;
}

function commitsBetween(cwd, base, head) {
  return git(cwd, ["rev-list", "--reverse", "--no-merges", `${base}..${head}`])
    .split("\n").filter(Boolean);
}

function restoreWorkflowTree(cwd, alasRef) {
  const remove = spawnSync("git", ["rm", "-r", "--ignore-unmatch", ".github/workflows"], {
    cwd, encoding: "utf8", stdio: "pipe",
  });
  if (remove.status !== 0) throw new Error(remove.stderr || "Cannot clear candidate workflow tree");
  const tree = git(cwd, ["ls-tree", "-d", "--name-only", alasRef, ".github/workflows"]);
  if (tree) git(cwd, ["checkout", alasRef, "--", ".github/workflows"]);
  const changed = spawnSync("git", ["diff", "--cached", "--quiet", "--", ".github/workflows"], {
    cwd, encoding: "utf8", stdio: "pipe",
  });
  if (changed.status === 1) git(cwd, ["commit", "-m", "chore: retain downstream workflows for review"]);
  else if (changed.status !== 0) throw new Error(changed.stderr || "Cannot inspect candidate workflow tree");
}

export function buildSyncCandidate({
  cwd,
  tagRef,
  baseRef,
  upstreamRef,
  alasRef,
  branch,
  syncRefs = [],
  ledger,
}) {
  validatePatchLedger(ledger);
  const classifications = classifyDownstreamPatches({cwd, ledger, baseRef, targetRef: tagRef});
  const ledgerByPatchId = new Map(classifications.filter((patch) => patch.patchId)
    .map((patch) => [patch.patchId, patch]));
  const downstreamCommits = commitsBetween(cwd, upstreamRef, alasRef);
  const downstreamPatchIds = new Set(downstreamCommits.map((commit) => patchId(cwd, commit)).filter(Boolean));
  const preserved = [];
  const preservedPatchIds = new Set();
  const syncHeads = [];
  const unsupportedMergeCommits = new Set(
    git(cwd, ["rev-list", "--reverse", "--merges", `${upstreamRef}..${alasRef}`]).split("\n").filter(Boolean),
  );

  for (const ref of syncRefs) {
    const head = git(cwd, ["rev-parse", `${ref}^{commit}`]);
    syncHeads.push({ref, head});
    for (const merge of git(cwd, ["rev-list", "--reverse", "--merges", `${alasRef}..${ref}`]).split("\n").filter(Boolean)) {
      if (!isAncestor(cwd, merge, upstreamRef)) unsupportedMergeCommits.add(merge);
    }
    for (const commit of commitsBetween(cwd, alasRef, ref)) {
      if (isAncestor(cwd, commit, upstreamRef)) continue;
      const id = patchId(cwd, commit);
      if (id && (downstreamPatchIds.has(id) || preservedPatchIds.has(id))) continue;
      if (id) preservedPatchIds.add(id);
      preserved.push(commit);
    }
  }

  git(cwd, ["checkout", "-B", branch, `${tagRef}^{commit}`]);
  const appliedPatches = [];
  const appliedDownstreamCommits = [];
  const appliedSyncCommits = [];
  const conflicts = [];
  const seenLedgerPatches = new Set();
  for (const commit of downstreamCommits) {
    const id = patchId(cwd, commit);
    const patch = id ? ledgerByPatchId.get(id) : undefined;
    if (patch) {
      seenLedgerPatches.add(patch.name);
      if (patch.classification !== "unaffected") continue;
    }
    if (!cherryPick(cwd, commit)) {
      conflicts.push({commit, kind: "downstream", ...(patch ? {patch: patch.name} : {})});
      break;
    }
    appliedDownstreamCommits.push(commit);
    if (patch) appliedPatches.push(patch.name);
  }
  const missingLedgerPatches = classifications
    .filter((patch) => patch.classification === "unaffected" && !seenLedgerPatches.has(patch.name))
    .map((patch) => patch.name);
  if (conflicts.length === 0) {
    for (const commit of preserved) {
      if (!cherryPick(cwd, commit)) {
        conflicts.push({commit, kind: "sync-review"});
        break;
      }
      appliedSyncCommits.push(commit);
    }
  }

  const workflowChanges = git(cwd, ["diff", "--name-only", baseRef, tagRef, "--", ".github/workflows"])
    .split("\n").filter(Boolean);
  if (workflowChanges.length > 0) restoreWorkflowTree(cwd, alasRef);
  const manualPatches = classifications.filter((patch) => patch.classification !== "unaffected");
  const tagCommit = git(cwd, ["rev-parse", `${tagRef}^{commit}`]);
  const candidateCommit = git(cwd, ["rev-parse", "HEAD"]);
  const candidateMergeBase = git(cwd, ["merge-base", candidateCommit, upstreamRef]);
  if (candidateMergeBase !== tagCommit) {
    throw new Error(`Candidate merge-base ${candidateMergeBase} is not exact stable tag ${tagCommit}`);
  }
  return {
    tagCommit,
    candidateCommit,
    classifications,
    appliedPatches,
    appliedDownstreamCommits,
    missingLedgerPatches,
    preservedSyncCommits: appliedSyncCommits,
    syncHeads,
    workflowChanges,
    conflicts,
    unsupportedMergeCommits: [...unsupportedMergeCommits],
    manualReview: manualPatches.length > 0 || workflowChanges.length > 0 ||
      conflicts.length > 0 || unsupportedMergeCommits.size > 0 || missingLedgerPatches.length > 0,
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

export function pushSyncCandidate({cwd, branch, expectedRemoteSha = "", remote = "origin"}) {
  const lease = `--force-with-lease=refs/heads/${branch}:${expectedRemoteSha}`;
  try {
    git(cwd, ["push", lease, remote, `HEAD:refs/heads/${branch}`]);
  } catch (error) {
    throw new Error(String(error.stderr || error.message));
  }
  return git(cwd, ["rev-parse", "HEAD"]);
}

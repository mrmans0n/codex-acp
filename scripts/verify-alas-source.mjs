#!/usr/bin/env node

import {execFileSync, spawnSync} from "node:child_process";

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function compareVersions(left, right) {
  const leftParts = STABLE_VERSION.exec(left)?.slice(1).map(Number);
  const rightParts = STABLE_VERSION.exec(right)?.slice(1).map(Number);
  if (!leftParts || !rightParts) throw new Error(`Cannot compare stable versions ${left} and ${right}`);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function parents(cwd, commit) {
  return git(cwd, "show", "-s", "--format=%P", commit).split(/\s+/).filter(Boolean);
}

function isAncestor(cwd, ancestor, descendant) {
  return spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).status === 0;
}

function isReviewedIntegration({cwd, commit, upstreamCommit, upstreamMainRef}) {
  const commitParents = parents(cwd, commit);
  if (commitParents.length < 2 || commitParents.length > 3) return false;
  if (commitParents.length === 3 &&
      (commitParents[2] === commitParents[0] || !isAncestor(cwd, commitParents[0], commitParents[2]))) {
    return false;
  }
  const subject = git(cwd, "show", "-s", "--format=%s", commit);
  if (subject !== `chore: integrate exact upstream ${upstreamCommit.slice(0, 12)}`) return false;
  if (git(cwd, "rev-parse", `${commit}^{tree}`) !== git(cwd, "rev-parse", `${commitParents[1]}^{tree}`)) {
    return false;
  }
  if (git(cwd, "merge-base", commit, upstreamMainRef) !== upstreamCommit) return false;
  return git(cwd, "merge-base", commitParents[1], upstreamMainRef) === upstreamCommit;
}

function resolveReviewedIntegration({cwd, sourceCommit, upstreamCommit, upstreamMainRef}) {
  if (isReviewedIntegration({cwd, commit: sourceCommit, upstreamCommit, upstreamMainRef})) {
    return sourceCommit;
  }
  const sourceParents = parents(cwd, sourceCommit);
  if (sourceParents.length === 2 &&
      isReviewedIntegration({cwd, commit: sourceParents[1], upstreamCommit, upstreamMainRef})) {
    const integrationParents = parents(cwd, sourceParents[1]);
    const sourceTree = git(cwd, "rev-parse", `${sourceCommit}^{tree}`);
    const integrationTree = git(cwd, "rev-parse", `${sourceParents[1]}^{tree}`);
    if (sourceParents[0] === integrationParents[0] && sourceTree === integrationTree) {
      return sourceParents[1];
    }
  }
  throw new Error(`source commit ${sourceCommit} is not the reviewed protected integration result`);
}

function deriveReviewBaseTag({cwd, previousAlas, upstreamVersion}) {
  let manifest;
  try {
    manifest = JSON.parse(git(cwd, "show", `${previousAlas}:package.json`));
  } catch (error) {
    throw new Error(`Cannot read package version from integration first parent ${previousAlas}: ${error.message}`);
  }
  const baseVersion = manifest?.version;
  if (!STABLE_VERSION.test(String(baseVersion ?? ""))) {
    throw new Error(`Integration first parent package version must be stable, got ${JSON.stringify(baseVersion)}`);
  }
  if (compareVersions(baseVersion, upstreamVersion) >= 0) {
    throw new Error(`Integration review base v${baseVersion} must precede v${upstreamVersion}`);
  }
  return `v${baseVersion}`;
}

export function verifyAlasSource({
  cwd,
  sourceCommit,
  alasRef,
  upstreamTag,
  upstreamMainRef,
  packageVersion,
}) {
  if (!FULL_COMMIT.test(String(sourceCommit ?? ""))) {
    throw new Error("sourceCommit must be a full 40-character git commit");
  }
  const tagMatch = STABLE_TAG.exec(String(upstreamTag ?? ""));
  if (!tagMatch) throw new Error(`upstreamTag must be a stable vX.Y.Z tag, got ${JSON.stringify(upstreamTag)}`);
  const upstreamVersion = upstreamTag.slice(1);
  if (packageVersion !== upstreamVersion) {
    throw new Error(`package version ${packageVersion} does not match declared upstream tag ${upstreamTag}`);
  }

  const alasCommit = git(cwd, "rev-parse", `${alasRef}^{commit}`);
  if (sourceCommit !== alasCommit) {
    throw new Error(`sourceCommit ${sourceCommit} is not the current ${alasRef} commit ${alasCommit}`);
  }
  const upstreamCommit = git(cwd, "rev-parse", `${upstreamTag}^{commit}`);
  const mergeBase = git(cwd, "merge-base", sourceCommit, upstreamMainRef);
  if (mergeBase !== upstreamCommit) {
    throw new Error(`merge-base with upstream main must be exactly ${upstreamTag} (${upstreamCommit}), got ${mergeBase}`);
  }
  const integrationCommit = resolveReviewedIntegration({
    cwd,
    sourceCommit,
    upstreamCommit,
    upstreamMainRef,
  });
  const integrationParents = parents(cwd, integrationCommit);
  const previousAlas = integrationParents[0];
  const exactCandidateCommit = integrationParents[1];
  const canonicalHead = integrationParents[2] ?? null;
  const reviewBaseTag = deriveReviewBaseTag({cwd, previousAlas, upstreamVersion});
  return {
    sourceCommit,
    upstreamVersion,
    upstreamCommit,
    reviewBaseTag,
    integrationCommit,
    exactCandidateCommit,
    previousAlas,
    canonicalHead,
  };
}

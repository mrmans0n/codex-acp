#!/usr/bin/env node

import {execFileSync} from "node:child_process";

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

function deriveReviewBaseTag({cwd, sourceCommit, upstreamCommit, upstreamMainRef, upstreamVersion}) {
  const commits = git(cwd, "rev-list", "--topo-order", sourceCommit).split("\n").filter(Boolean);
  for (const commit of commits) {
    const subject = git(cwd, "show", "-s", "--format=%s", commit);
    if (!subject.startsWith("chore: integrate exact upstream ")) continue;
    const parents = git(cwd, "show", "-s", "--format=%P", commit).split(/\s+/).filter(Boolean);
    if (parents.length !== 2) continue;
    if (git(cwd, "rev-parse", `${commit}^{tree}`) !== git(cwd, "rev-parse", `${parents[1]}^{tree}`)) continue;
    if (git(cwd, "merge-base", commit, upstreamMainRef) !== upstreamCommit) continue;

    let manifest;
    try {
      manifest = JSON.parse(git(cwd, "show", `${parents[0]}:package.json`));
    } catch (error) {
      throw new Error(`Cannot read package version from integration first parent ${parents[0]}: ${error.message}`);
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
  throw new Error(`Cannot derive review base from protected alas integration ancestry at ${sourceCommit}`);
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
  const reviewBaseTag = deriveReviewBaseTag({
    cwd,
    sourceCommit,
    upstreamCommit,
    upstreamMainRef,
    upstreamVersion,
  });
  return {sourceCommit, upstreamVersion, upstreamCommit, reviewBaseTag};
}

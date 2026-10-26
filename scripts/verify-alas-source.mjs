#!/usr/bin/env node

import {execFileSync} from "node:child_process";

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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
  return {sourceCommit, upstreamVersion, upstreamCommit};
}

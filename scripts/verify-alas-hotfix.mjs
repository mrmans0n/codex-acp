#!/usr/bin/env node

import {execFileSync, spawnSync} from "node:child_process";

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isAncestor(cwd, ancestor, descendant) {
  return spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).status === 0;
}

function publishedRevisions(packument, upstreamVersion) {
  const pattern = new RegExp(`^${upstreamVersion.replaceAll(".", "\\.")}-alas\\.(0|[1-9]\\d*)$`);
  return Object.entries(packument?.versions ?? {})
    .map(([version, manifest]) => ({version, revision: Number(pattern.exec(version)?.[1]), manifest}))
    .filter(({revision}) => Number.isSafeInteger(revision))
    .sort((left, right) => right.revision - left.revision);
}

/**
 * Verifies a downstream-only hotfix publication.
 *
 * A hotfix republishes the upstream version of an existing Alas publication with reviewed
 * fork commits on top. It must descend from the latest published revision of that version
 * and must not bring in upstream history beyond what that publication already contained.
 */
export function verifyAlasHotfix({
  cwd,
  sourceCommit,
  alasRef,
  upstreamTag,
  upstreamMainRef,
  packageVersion,
  packument,
}) {
  if (!FULL_COMMIT.test(String(sourceCommit ?? ""))) {
    throw new Error("sourceCommit must be a full 40-character git commit");
  }
  if (!STABLE_TAG.test(String(upstreamTag ?? ""))) {
    throw new Error(`upstreamTag must be a stable vX.Y.Z tag, got ${JSON.stringify(upstreamTag)}`);
  }
  const upstreamVersion = upstreamTag.slice(1);
  if (packageVersion !== upstreamVersion) {
    throw new Error(`package version ${packageVersion} does not match declared upstream tag ${upstreamTag}`);
  }
  const alasCommit = git(cwd, "rev-parse", `${alasRef}^{commit}`);
  if (sourceCommit !== alasCommit) {
    throw new Error(`sourceCommit ${sourceCommit} is not the current ${alasRef} commit ${alasCommit}`);
  }
  const upstreamCommit = git(cwd, "rev-parse", `${upstreamTag}^{commit}`);

  const base = publishedRevisions(packument, upstreamVersion)
    .find(({manifest}) => manifest?.alasDownstream?.sourceCommit !== sourceCommit);
  if (!base) {
    throw new Error(`A hotfix needs an existing ${upstreamVersion}-alas.N publication to build on`);
  }
  const metadata = base.manifest?.alasDownstream ?? {};
  if (metadata.upstreamVersion !== upstreamVersion || metadata.upstreamCommit !== upstreamCommit ||
      !FULL_COMMIT.test(String(metadata.sourceCommit ?? ""))) {
    throw new Error(`Published ${base.version} metadata does not match ${upstreamTag} (${upstreamCommit})`);
  }
  const baseSourceCommit = metadata.sourceCommit;
  if (baseSourceCommit === sourceCommit || !isAncestor(cwd, baseSourceCommit, sourceCommit)) {
    throw new Error(`sourceCommit ${sourceCommit} does not descend from published ${base.version} (${baseSourceCommit})`);
  }

  const baseMergeBase = git(cwd, "merge-base", baseSourceCommit, upstreamMainRef);
  const mergeBase = git(cwd, "merge-base", sourceCommit, upstreamMainRef);
  if (mergeBase !== baseMergeBase) {
    throw new Error(`Hotfix brings in upstream history: merge-base with upstream main moved from ${baseMergeBase} to ${mergeBase}`);
  }

  return {
    sourceCommit,
    upstreamVersion,
    upstreamCommit,
    baseVersion: base.version,
    baseSourceCommit,
  };
}

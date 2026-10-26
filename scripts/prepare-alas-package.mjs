#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const UPSTREAM_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/i;

function stableVersion(version) {
  const value = String(version ?? "");
  if (!UPSTREAM_VERSION.test(value)) {
    throw new Error(`expected a stable upstream X.Y.Z version, got ${JSON.stringify(version)}`);
  }
  return value;
}

function publishedManifests(published) {
  if (Array.isArray(published)) return published;
  if (published && typeof published === "object") {
    if (published.versions && typeof published.versions === "object") {
      return Object.entries(published.versions).map(([version, manifest]) =>
        typeof manifest === "object" && manifest !== null ? { version, ...manifest } : { version },
      );
    }
    return Object.entries(published).map(([version, manifest]) =>
      typeof manifest === "object" && manifest !== null ? { version, ...manifest } : { version },
    );
  }
  throw new Error("published data must be an array or npm packument object");
}

export function selectAlasVersion({ upstreamVersion, sourceCommit, published }) {
  const base = stableVersion(upstreamVersion);
  if (!sourceCommit) throw new Error("source commit is required");

  let highestRevision = 0;
  let existingVersion;
  for (const manifest of publishedManifests(published)) {
    const version = typeof manifest === "string" ? manifest : manifest?.version;
    const match = new RegExp(`^${base.replaceAll(".", "\\.")}-alas\\.(0|[1-9]\\d*)$`).exec(version ?? "");
    if (!match) continue;
    const revision = Number(match[1]);
    if (manifest?.alasDownstream?.sourceCommit === sourceCommit) {
      existingVersion = version;
      break;
    }
    highestRevision = Math.max(highestRevision, revision);
  }
  return existingVersion
    ? { version: existingVersion, alreadyPublished: true }
    : { version: `${base}-alas.${highestRevision + 1}`, alreadyPublished: false };
}

export function prepareAlasPackage(packageJson, metadata) {
  for (const [key, value] of Object.entries({
    upstreamCommit: metadata?.upstreamCommit,
    sourceCommit: metadata?.sourceCommit,
  })) {
    if (!FULL_COMMIT.test(String(value ?? ""))) {
      throw new Error(`${key} must be a full 40-character git commit`);
    }
  }
  const upstreamVersion = stableVersion(metadata?.upstreamVersion);
  const { version } = selectAlasVersion({
    upstreamVersion,
    sourceCommit: metadata.sourceCommit,
    published: metadata.published,
  });
  return {
    ...packageJson,
    name: "@alas-ide/codex-acp",
    version,
    homepage: "https://github.com/mrmans0n/codex-acp#readme",
    bugs: { ...packageJson.bugs, url: "https://github.com/mrmans0n/codex-acp/issues" },
    repository: { ...packageJson.repository, url: "git+https://github.com/mrmans0n/codex-acp.git" },
    alasDownstream: {
      upstreamVersion,
      upstreamCommit: metadata.upstreamCommit,
      sourceCommit: metadata.sourceCommit,
    },
  };
}

function main() {
  const required = [
    "ALAS_UPSTREAM_VERSION",
    "ALAS_UPSTREAM_COMMIT",
    "ALAS_SOURCE_COMMIT",
    "ALAS_PUBLISHED_JSON",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }

  const packagePath = "package.json";
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const published = JSON.parse(process.env.ALAS_PUBLISHED_JSON);
  const prepared = prepareAlasPackage(packageJson, {
    upstreamVersion: process.env.ALAS_UPSTREAM_VERSION,
    upstreamCommit: process.env.ALAS_UPSTREAM_COMMIT,
    sourceCommit: process.env.ALAS_SOURCE_COMMIT,
    published,
  });
  writeFileSync(packagePath, `${JSON.stringify(prepared, null, 2)}\n`);
  const { alreadyPublished } = selectAlasVersion({
    upstreamVersion: process.env.ALAS_UPSTREAM_VERSION,
    sourceCommit: process.env.ALAS_SOURCE_COMMIT,
    published,
  });
  process.stdout.write(`${JSON.stringify({ version: prepared.version, alreadyPublished })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

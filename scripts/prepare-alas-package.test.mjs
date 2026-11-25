import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { prepareAlasPackage, selectAlasVersion } from "./prepare-alas-package.mjs";

const sourceCommit = "a".repeat(40);
const upstreamCommit = "b".repeat(40);

test("selects the first downstream revision", () => {
  assert.deepEqual(
    selectAlasVersion({ upstreamVersion: "2.1.1", sourceCommit, published: [] }),
    { version: "2.1.1-alas.1", alreadyPublished: false },
  );
});

test("increments the highest revision for the same upstream version", () => {
  assert.deepEqual(
    selectAlasVersion({
      upstreamVersion: "2.1.1",
      sourceCommit,
      published: [
        { version: "2.1.1-alas.2", alasDownstream: { sourceCommit: "older" } },
        { version: "2.1.1-alas.5", alasDownstream: { sourceCommit: "older" } },
        { version: "2.1.0-alas.8", alasDownstream: { sourceCommit: "older" } },
      ],
    }),
    { version: "2.1.1-alas.6", alreadyPublished: false },
  );
});

test("reuses the published version for the same source commit", () => {
  assert.deepEqual(
    selectAlasVersion({
      upstreamVersion: "2.1.1",
      upstreamCommit,
      sourceCommit,
      published: [
        {
          version: "2.1.1-alas.2",
          alasDownstream: {upstreamVersion: "2.1.1", upstreamCommit, sourceCommit},
        },
      ],
    }),
    { version: "2.1.1-alas.2", alreadyPublished: true },
  );
});

test("rejects a source commit already published with mismatched upstream metadata", () => {
  assert.throws(
    () => selectAlasVersion({
      upstreamVersion: "2.1.1",
      upstreamCommit,
      sourceCommit,
      published: [
        {
          version: "2.1.0-alas.4",
          alasDownstream: {
            upstreamVersion: "2.1.0",
            upstreamCommit: "c".repeat(40),
            sourceCommit,
          },
        },
      ],
    }),
    /already published.*metadata mismatch/i,
  );
});

test("rejects a source commit published under a malformed or ambiguous downstream version", () => {
  for (const published of [
    [{
      version: "2.1.1-alas.not-a-revision",
      alasDownstream: {upstreamVersion: "2.1.1", upstreamCommit, sourceCommit},
    }],
    [
      {
        version: "2.1.1-alas.1",
        alasDownstream: {upstreamVersion: "2.1.1", upstreamCommit, sourceCommit},
      },
      {
        version: "2.1.1-alas.2",
        alasDownstream: {upstreamVersion: "2.1.1", upstreamCommit, sourceCommit},
      },
    ],
  ]) {
    assert.throws(() => selectAlasVersion({
      upstreamVersion: "2.1.1",
      upstreamCommit,
      sourceCommit,
      published,
    }), /metadata mismatch|ambiguous/i);
  }
});

test("requires a full source commit hash", () => {
  assert.throws(
    () => selectAlasVersion({ upstreamVersion: "2.1.1", sourceCommit: "abc1234", published: [] }),
    /full 40-character git commit/,
  );
});

test("prepares publish-only package metadata", () => {
  const upstreamPackage = {
    name: "@agentclientprotocol/codex-acp",
    version: "2.1.1",
    bin: { "codex-acp": "dist/index.js" },
    files: ["dist/index.js", "README.md", "LICENSE", "package.json"],
    repository: { type: "git", url: "git+https://github.com/agentclientprotocol/codex-acp.git" },
    homepage: "https://github.com/agentclientprotocol/codex-acp#readme",
    bugs: { url: "https://github.com/agentclientprotocol/codex-acp/issues" },
  };
  const prepared = prepareAlasPackage(upstreamPackage, {
    upstreamVersion: "2.1.1",
    upstreamCommit,
    sourceCommit,
    published: [],
  });

  assert.equal(prepared.name, "@alas-ide/codex-acp");
  assert.equal(prepared.version, "2.1.1-alas.1");
  assert.equal(prepared.bin["codex-acp"], "dist/index.js");
  assert.equal(prepared.repository.url, "git+https://github.com/mrmans0n/codex-acp.git");
  assert.equal(prepared.homepage, "https://github.com/mrmans0n/codex-acp#readme");
  assert.equal(prepared.bugs.url, "https://github.com/mrmans0n/codex-acp/issues");
  assert.deepEqual(prepared.files, upstreamPackage.files);
  assert.deepEqual(prepared.alasDownstream, {
    upstreamVersion: "2.1.1",
    upstreamCommit,
    sourceCommit,
  });
  assert.equal(upstreamPackage.name, "@agentclientprotocol/codex-acp");
});

test("requires a stable upstream version and full commit hashes", () => {
  const metadata = {
    upstreamVersion: "2.1.1-rc.1",
    upstreamCommit,
    sourceCommit,
    published: [],
  };
  assert.throws(() => prepareAlasPackage({}, metadata), /stable upstream/);
  assert.throws(
    () => prepareAlasPackage({}, { ...metadata, upstreamVersion: "2.1.1", sourceCommit: "abc1234" }),
    /full 40-character git commit/,
  );
});

const cliScript = fileURLToPath(new URL("./prepare-alas-package.mjs", import.meta.url));
const cliOriginalPackage = `${JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "2.1.1" })}\n`;
const cliDirectories = [];

afterEach(() => {
  for (const directory of cliDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cliFixture(published = "[]") {
  const directory = mkdtempSync(join(tmpdir(), "alas-package-"));
  cliDirectories.push(directory);
  writeFileSync(join(directory, "package.json"), cliOriginalPackage);
  const publishedFile = join(directory, "published.json");
  writeFileSync(publishedFile, published);
  return {
    publishedFile,
    run(overrides) {
      const env = { ...process.env };
      delete env.ALAS_PUBLISHED_JSON;
      delete env.ALAS_PUBLISHED_FILE;
      const result = spawnSync(process.execPath, [cliScript], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...env,
          ALAS_UPSTREAM_VERSION: "2.1.1",
          ALAS_UPSTREAM_COMMIT: upstreamCommit,
          ALAS_SOURCE_COMMIT: sourceCommit,
          ...overrides,
        },
      });
      return { ...result, packageText: readFileSync(join(directory, "package.json"), "utf8") };
    },
  };
}

for (const route of ["json", "file"]) {
  test(`CLI preserves exact-source idempotency through the ${route} route`, () => {
    const published = JSON.stringify({
      versions: {
        "2.1.1-alas.7": {
          alasDownstream: { sourceCommit, upstreamCommit, upstreamVersion: "2.1.1" },
        },
      },
    });
    const { run, publishedFile } = cliFixture(published);
    const result = run(route === "file" ? { ALAS_PUBLISHED_FILE: publishedFile } : { ALAS_PUBLISHED_JSON: published });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { version: "2.1.1-alas.7", alreadyPublished: true });
  });
}

for (const [name, env, error] of [
  ["neither source", {}, /exactly one of ALAS_PUBLISHED_FILE or ALAS_PUBLISHED_JSON is required/],
  [
    "empty sources",
    { ALAS_PUBLISHED_FILE: "", ALAS_PUBLISHED_JSON: "" },
    /exactly one of ALAS_PUBLISHED_FILE or ALAS_PUBLISHED_JSON is required/,
  ],
  [
    "both sources",
    { ALAS_PUBLISHED_FILE: "published.json", ALAS_PUBLISHED_JSON: "[]" },
    /exactly one of ALAS_PUBLISHED_FILE or ALAS_PUBLISHED_JSON is required/,
  ],
  ["missing file", { ALAS_PUBLISHED_FILE: "missing.json" }, /ENOENT/],
  ["malformed file JSON", { ALAS_PUBLISHED_FILE: "published.json" }, /JSON/],
  ["malformed legacy JSON", { ALAS_PUBLISHED_JSON: "{" }, /JSON/],
  ["invalid file data", { ALAS_PUBLISHED_FILE: "published.json" }, /array or npm packument/],
  ["invalid legacy data", { ALAS_PUBLISHED_JSON: "null" }, /array or npm packument/],
  ["invalid commit", { ALAS_PUBLISHED_JSON: "[]", ALAS_SOURCE_COMMIT: "short" }, /40-character/],
  ["invalid file commit", { ALAS_PUBLISHED_FILE: "published.json", ALAS_SOURCE_COMMIT: "short" }, /40-character/],
  [
    "missing metadata",
    { ALAS_PUBLISHED_FILE: "published.json", ALAS_UPSTREAM_COMMIT: "" },
    /ALAS_UPSTREAM_COMMIT is required/,
  ],
]) {
  test(`CLI rejects ${name} before changing the package`, () => {
    const contents = name === "malformed file JSON" ? "{" : name === "invalid file commit" ? "[]" : "null";
    const { run } = cliFixture(contents);
    const result = run(env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.equal(result.stdout, "");
    assert.equal(result.packageText, cliOriginalPackage);
  });
}

test("CLI reads a packument larger than Linux's 128 KiB per-environment-string limit from a file", () => {
  const published = JSON.stringify({
    versions: { "2.1.1-alas.2": { description: "x".repeat(128 * 1024) } },
  });
  assert.ok(Buffer.byteLength(published) > 128 * 1024);
  const { run, publishedFile } = cliFixture(published);
  const result = run({ ALAS_PUBLISHED_FILE: publishedFile });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { version: "2.1.1-alas.3", alreadyPublished: false });
  const prepared = JSON.parse(result.packageText);
  assert.equal(prepared.name, "@alas-ide/codex-acp");
  assert.equal(prepared.version, "2.1.1-alas.3");
  assert.deepEqual(prepared.alasDownstream, { upstreamVersion: "2.1.1", upstreamCommit, sourceCommit });
});

import assert from "node:assert/strict";
import test from "node:test";
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
      sourceCommit,
      published: [
        { version: "2.1.1-alas.2", alasDownstream: { sourceCommit } },
      ],
    }),
    { version: "2.1.1-alas.2", alreadyPublished: true },
  );
});

test("reuses a source commit published under another upstream base", () => {
  assert.deepEqual(
    selectAlasVersion({
      upstreamVersion: "2.1.1",
      sourceCommit,
      published: [
        { version: "2.1.0-alas.4", alasDownstream: { sourceCommit } },
      ],
    }),
    { version: "2.1.0-alas.4", alreadyPublished: true },
  );
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

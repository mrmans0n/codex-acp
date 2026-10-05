import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, test} from "vitest";
import {verifyAlasHotfix} from "./verify-alas-hotfix.mjs";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

function commitFile(cwd, path, contents, message) {
  writeFileSync(join(cwd, path), contents);
  git(cwd, "add", path);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

let f;

beforeAll(() => {
  const cwd = mkdtempSync(join(tmpdir(), "alas-hotfix-"));
  git(cwd, "init", "-b", "upstream");
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  const stable = commitFile(cwd, "package.json", '{"version":"2.1.0"}\n', "stable");
  git(cwd, "tag", "v2.1.0");
  const preview = commitFile(cwd, "preview.txt", "preview\n", "post-stable preview");

  git(cwd, "checkout", "-b", "alas", stable);
  const published = commitFile(cwd, "downstream.txt", "downstream\n", "downstream");
  const hotfix = commitFile(cwd, "hotfix.txt", "hotfix\n", "hotfix");
  git(cwd, "checkout", "-b", "contaminated", hotfix);
  git(cwd, "merge", "--no-ff", "upstream", "-m", "merge upstream main");
  const contaminated = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "-b", "unrelated", stable);
  const unrelated = commitFile(cwd, "other.txt", "other\n", "unrelated");
  f = {cwd, stable, preview, published, hotfix, contaminated, unrelated};
});

afterAll(() => {
  rmSync(f.cwd, {recursive: true, force: true});
});

function packument(...entries) {
  return {
    versions: Object.fromEntries(entries.map(([version, sourceCommit]) => [version, {
      version,
      alasDownstream: {upstreamVersion: "2.1.0", upstreamCommit: f.stable, sourceCommit},
    }])),
  };
}

function verify(overrides = {}) {
  return verifyAlasHotfix({
    cwd: f.cwd,
    sourceCommit: f.hotfix,
    alasRef: "alas",
    upstreamTag: "v2.1.0",
    upstreamMainRef: "upstream",
    packageVersion: "2.1.0",
    packument: packument(["2.1.0-alas.1", f.published]),
    ...overrides,
  });
}

test("accepts fork commits on top of the latest publication of the same upstream version", () => {
  assert.deepEqual(verify(), {
    sourceCommit: f.hotfix,
    upstreamVersion: "2.1.0",
    upstreamCommit: f.stable,
    baseVersion: "2.1.0-alas.1",
    baseSourceCommit: f.published,
  });
});

test("builds a rerun of an already published hotfix on the revision before it", () => {
  assert.equal(verify({
    packument: packument(["2.1.0-alas.1", f.published], ["2.1.0-alas.2", f.hotfix]),
  }).baseVersion, "2.1.0-alas.1");
});

test.each([
  ["a source that is not the alas head", () => ({sourceCommit: f.published}), /is not the current alas commit/],
  ["a package version other than the tag", () => ({packageVersion: "2.1.1"}), /does not match declared upstream tag/],
  ["no publication to build on", () => ({packument: {versions: {}}}), /needs an existing 2\.1\.0-alas\.N publication/],
  ["a source that does not descend from the publication", () => ({
    packument: packument(["2.1.0-alas.1", f.unrelated]),
  }), /does not descend from published 2\.1\.0-alas\.1/],
  ["new upstream history", () => ({
    alasRef: "contaminated",
    sourceCommit: f.contaminated,
  }), /brings in upstream history/],
  ["publication metadata for another upstream commit", () => ({
    packument: {versions: {"2.1.0-alas.1": {alasDownstream: {
      upstreamVersion: "2.1.0", upstreamCommit: f.preview, sourceCommit: f.published,
    }}}},
  }), /metadata does not match v2\.1\.0/],
])("rejects %s", (_name, overrides, error) => {
  assert.throws(() => verify(overrides()), error);
});

import assert from "node:assert/strict";
import {test} from "vitest";
import {
  selectNewestStableRelease,
  verifyUpstreamRelease,
} from "./upstream-release.mjs";

const commit = "a".repeat(40);

test("selects only a non-draft non-prerelease stable release newer than the package upstream version", () => {
  assert.deepEqual(selectNewestStableRelease({
    currentVersion: "2.1.1",
    releases: [
      {tag_name: "v2.1.2-preview.1", draft: false, prerelease: true},
      {tag_name: "v2.1.2", draft: true, prerelease: false},
      {tag_name: "v2.2.0", draft: false, prerelease: false},
      {tag_name: "v2.10.0", draft: false, prerelease: false},
      {tag_name: "v2.0.0", draft: false, prerelease: false},
    ],
  }), {tag_name: "v2.10.0", draft: false, prerelease: false});
  assert.equal(selectNewestStableRelease({
    currentVersion: "2.10.0",
    releases: [{tag_name: "v2.10.0", draft: false, prerelease: false}],
  }), null);
});

test("verifies GitHub release, npm latest, and npm gitHead agreement", () => {
  assert.deepEqual(verifyUpstreamRelease({
    tag: "v2.2.0",
    tagCommit: commit,
    release: {tag_name: "v2.2.0", draft: false, prerelease: false},
    npm: {version: "2.2.0", gitHead: commit},
  }), {tag: "v2.2.0", version: "2.2.0", commit});
  assert.deepEqual(verifyUpstreamRelease({
    tag: "v2.2.0",
    tagCommit: commit,
    release: {tag_name: "v2.2.0", draft: false, prerelease: false},
    npm: {version: "2.2.0"},
  }), {tag: "v2.2.0", version: "2.2.0", commit});
});

test("rejects release and npm disagreement", () => {
  const base = {
    tag: "v2.2.0",
    tagCommit: commit,
    release: {tag_name: "v2.2.0", draft: false, prerelease: false},
    npm: {version: "2.2.0", gitHead: commit},
  };
  assert.throws(() => verifyUpstreamRelease({...base, release: {...base.release, draft: true}}), /draft/i);
  assert.throws(() => verifyUpstreamRelease({...base, release: {...base.release, prerelease: true}}), /prerelease/i);
  assert.throws(() => verifyUpstreamRelease({...base, release: {...base.release, tag_name: "v2.1.9"}}), /does not match/i);
  assert.throws(() => verifyUpstreamRelease({...base, npm: {...base.npm, version: "2.1.9"}}), /npm latest/i);
  assert.throws(() => verifyUpstreamRelease({...base, npm: {...base.npm, gitHead: "b".repeat(40)}}), /gitHead/i);
});

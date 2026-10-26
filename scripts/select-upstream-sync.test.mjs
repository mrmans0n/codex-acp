import assert from "node:assert/strict";
import {test} from "vitest";
import {selectUpstreamSync} from "./select-upstream-sync.mjs";

test("selects the newest stable tag by numeric semver order", () => {
  assert.deepEqual(selectUpstreamSync({
    tags: ["v2.9.9", "v2.10.0", "v1.99.99"], openHeads: [],
  }), {tag: "v2.10.0", branch: "sync/upstream-2.10.0", staleHeads: []});
});

test("ignores prereleases and malformed versions", () => {
  assert.deepEqual(selectUpstreamSync({
    tags: ["v2.1.1", "v3.0.0-rc.1", "v3.0.0-preview.4", "v03.0.0", "unrelated"],
    openHeads: [],
  }), {tag: "v2.1.1", branch: "sync/upstream-2.1.1", staleHeads: []});
  assert.equal(selectUpstreamSync({tags: ["v3.0.0-rc.1"], openHeads: []}), null);
});

test("does no work when the newest stable tag is already in alas", () => {
  assert.equal(selectUpstreamSync({
    tags: [{name: "v2.1.0", merged: false}, {name: "v2.1.1", merged: true}],
    openHeads: ["sync/upstream-2.1.0"],
  }), null);
});

test("selects the newest merged stable tag as the comparison base", () => {
  assert.deepEqual(selectUpstreamSync({
    tags: [
      {name: "v2.0.0", merged: true},
      {name: "v2.1.0-preview.1", merged: true},
      {name: "v2.1.0", merged: false},
    ],
    openHeads: [],
  }), {
    tag: "v2.1.0",
    branch: "sync/upstream-2.1.0",
    staleHeads: [],
    baseTag: "v2.0.0",
  });
});

test("reuses the canonical head and identifies only older stable sync heads", () => {
  assert.deepEqual(selectUpstreamSync({
    tags: ["v2.1.0", "v2.1.1"],
    openHeads: ["sync/upstream-2.1.0", "feature/other", "sync/upstream-2.1.1"],
  }), {tag: "v2.1.1", branch: "sync/upstream-2.1.1", staleHeads: ["sync/upstream-2.1.0"]});
});

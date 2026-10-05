import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {test} from "vitest";

const root = new URL("..", import.meta.url).pathname;
const workflowsDir = join(root, ".github/workflows");
const sync = readFileSync(join(workflowsDir, "sync-upstream.yml"), "utf8");
const publish = readFileSync(join(workflowsDir, "publish-alas.yml"), "utf8");
const ci = readFileSync(join(workflowsDir, "ci.yml"), "utf8");
const e2e = readFileSync(join(workflowsDir, "e2e.yml"), "utf8");
const upstreamPublish = readFileSync(join(workflowsDir, "publish.yml"), "utf8");
const checkoutSha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNodeSha = "820762786026740c76f36085b0efc47a31fe5020";
const createGitHubAppTokenV3Sha = "bcd2ba49218906704ab6c1aa796996da409d3eb1";

test("pins checkout and setup-node to the reviewed full SHAs in every workflow", () => {
  for (const name of readdirSync(workflowsDir).filter((entry) => entry.endsWith(".yml"))) {
    const workflow = readFileSync(join(workflowsDir, name), "utf8");
    for (const match of workflow.matchAll(/uses:\s*(actions\/(?:checkout|setup-node))@([^\s]+)/g)) {
      const expected = match[1] === "actions/checkout" ? checkoutSha : setupNodeSha;
      assert.equal(match[2], expected, `${name}: ${match[1]}`);
    }
  }
});

test("CI fetches full history and tags required by the committed patch ledger tests", () => {
  assert.match(ci, /actions\/checkout@[^\n]+\n\s+with:\n\s+fetch-depth:\s*0/);
});

test("pins create-github-app-token v3 to the reviewed official full SHA", () => {
  let uses = 0;
  for (const name of readdirSync(workflowsDir).filter((entry) => entry.endsWith(".yml"))) {
    const workflow = readFileSync(join(workflowsDir, name), "utf8");
    for (const match of workflow.matchAll(/uses:\s*actions\/create-github-app-token@([^\s]+)/g)) {
      uses += 1;
      assert.equal(match[1], createGitHubAppTokenV3Sha, name);
    }
  }
  assert.equal(uses, 3);
});

test("sync maintenance has no GitHub Issues dependency and persists manual review in a draft PR", () => {
  assert.doesNotMatch(sync, /\bissues:\s*write\b|gh issue/);
  assert.match(sync, /\$GITHUB_STEP_SUMMARY/);
  assert.match(sync, /gh pr create[\s\S]*--draft/);
  assert.match(sync, /gh pr ready[\s\S]*--undo/);
  assert.match(sync, /scripts\/sync-candidate\.mjs/);
  assert.match(sync, /docs\/alas-downstream-patches\.json/);
  assert.match(sync, /refs\/alas-upstream-main/);
});

test("sync reports absorbed, overlap, conflicts, and workflow changes as fail-closed manual review", () => {
  for (const marker of ["absorbed", "overlap", "conflict", "workflowChanges", "manualReview"]) {
    assert.match(sync, new RegExp(marker));
  }
  assert.match(sync, /exit 1/);
});

test("sync and publish verify the GitHub stable release against npm latest and gitHead", () => {
  for (const workflow of [sync, publish]) {
    assert.match(workflow, /upstream-release\.mjs/);
    assert.match(workflow, /verifyUpstreamRelease/);
    assert.match(workflow, /registry\.npmjs\.org\/.*codex-acp.*latest/i);
    assert.match(workflow, /releases/);
  }
  assert.match(sync, /selectNewestStableRelease/);
  assert.match(sync, /package\.json/);
});

test("sync keeps an exact candidate and pushes only a protected-branch-descended integration PR branch", () => {
  assert.match(sync, /exactBranch/);
  assert.match(sync, /exactCandidateCommit/);
  assert.match(sync, /integrationCommit/);
  assert.match(sync, /pushSyncCandidate[\s\S]*ref:\s*report\.exactBranch/);
  assert.doesNotMatch(sync, /HEAD:refs\/heads\/alas|\bgit\s+push[^\n]*\balas\b/);
});

test("sync reports stale heads without replay and marks preserved canonical edits for manual review", () => {
  assert.match(sync, /staleSyncHeads/);
  assert.match(sync, /preservedSyncCommits/);
  assert.match(sync, /preserved-canonical-sync-commits/);
});

test("sync commits provenance artifacts and publish independently reconstructs and verifies them", () => {
  for (const workflow of [sync, publish]) assert.match(workflow, /alas-sync-review\.json/);
  assert.match(publish, /validatePatchLedger/);
  assert.match(publish, /verifySyncSourceReview/);
  assert.match(publish, /verify-sync-source-review\.mjs/);
  assert.doesNotMatch(publish, /baseRef:\s*review\.fromTag|fromTag:\s*review\.fromTag/);
});

test("maintenance failures always write a durable summary and update an existing draft PR when possible", () => {
  assert.match(sync, /if:\s*\$\{\{ always\(\) \}\}/);
  assert.match(sync, /GITHUB_STEP_SUMMARY/);
  assert.match(sync, /gh pr edit/);
  assert.match(publish, /if:\s*\$\{\{ always\(\) \}\}/);
  assert.match(publish, /GITHUB_STEP_SUMMARY/);
});

test("e2e and upstream publish visibly waive live e2e when OPENAI_API_KEY is absent", () => {
  for (const workflow of [e2e, upstreamPublish]) {
    assert.match(workflow, /OPENAI_API_KEY/);
    assert.match(workflow, /if:\s*\$\{\{[^\n]*OPENAI_API_KEY[^\n]*!=\s*''/);
    assert.match(workflow, /E2E.*waived|waived.*E2E/i);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  }
});

test("publish verifies the declared stable tag against the exact upstream-main merge-base", () => {
  assert.match(publish, /upstream_tag:/);
  assert.match(publish, /refs\/alas-upstream-main/);
  assert.match(publish, /verify-sync-source-review\.mjs/);
  assert.doesNotMatch(publish, /merge-base --is-ancestor/);
  assert.match(publish, /environment: npm/);
  assert.match(publish, /id-token: write/);
});

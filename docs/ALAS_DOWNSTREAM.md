# Alas downstream maintenance and publication

`mrmans0n/codex-acp` maintains the protected `alas` branch and publishes
`@alas-ide/codex-acp`. The committed manifest keeps the upstream package name
and stable version. Publication rewrites only the runner's manifest to
`X.Y.Z-alas.N` and records `alasDownstream.upstreamVersion`, `upstreamCommit`,
and `sourceCommit`.

Publication is always a human-dispatched, environment-approved action. The npm
job retains only `contents: read` and `id-token: write`; npm authentication uses
OIDC provenance, not a stored token.

## Downstream patch ledger

`docs/alas-downstream-patches.json` is the versioned ledger for the functional
patches carried by Alas. Every entry records:

- a stable name;
- the exact downstream commit;
- the related upstream PR number, or `null` when no upstream PR exists;
- the complete changed-file list; and
- the tests that cover the patch.

The current functional patches are `goal-opt-in` (upstream PR #583) and
`async-tasks-opt-in` (no upstream PR yet). Keep ledger entries and their file
lists exact when a patch changes. `npm run test:maintenance` verifies the ledger
against the recorded commits.

For every new stable tag, `scripts/downstream-patches.mjs` compares each ledger
entry with the upstream stable delta:

- `unaffected`: no equivalent patch and no changed-path overlap;
- `absorbed`: an upstream commit has the same stable patch-id; or
- `overlap`: upstream changed at least one ledger path without an equivalent
  patch.

`scripts/sync-candidate.mjs` writes the recomputed result to the committed,
versioned `docs/alas-sync-review.json` artifact. The artifact records
`fromTag`, `toTag`, `toCommit`, every classification, and an explicit
resolution. Only `unaffected` is auto-resolved as `retain`. An `absorbed` or
`overlap` entry remains blocked until a maintainer chooses `retain`, `adapt`,
or `drop` and records both a rationale and the tests used for that decision.
Publication recomputes the classifications and rejects stale, mismatched, or
unresolved artifacts.

The candidate follows the verified artifact resolution. Unresolved entries
leave the synchronization PR in draft and fail the sync job. A maintainer must
review the stable implementation, update or retire the ledger entry when
needed, run the recorded tests and full validation suite, and commit the
resolution to the canonical same-version sync branch. They never trigger
publication while unresolved.

## Stable upstream synchronization

The daily `Sync stable upstream` workflow reads the upstream version from
`package.json` and considers only GitHub releases with exact `vX.Y.Z` tags that
are neither drafts nor prereleases and are strictly newer than that version.
Before building anything, it requires the selected release tag commit to agree
with upstream npm `latest` and npm `gitHead` when npm publishes one. Any
GitHub/npm/tag disagreement fails closed and is written to the job summary.

`scripts/sync-candidate.mjs` first builds and retains an exact-tag candidate.
It classifies the functional ledger patches, follows the committed sync-review
resolutions, and replays fork-only commits from `origin/alas`. Stable patch IDs
exclude non-ledger cherry-picks that are already on upstream `main`; equivalents
that are absent from the target stable tag are reported as upstream-later and
are not replayed. Known ledger patches are governed by their recomputed
classification and explicit review resolution instead of that generic rule.

The workflow then creates the canonical `sync/upstream-X.Y.Z` integration PR
branch from the current protected `origin/alas` head and makes an explicit
no-fast-forward merge whose resulting tree is exactly the retained exact-tag
candidate. This gives the PR normal first-parent ancestry from `alas` without
copying preview-only content into the release tree. Both the exact candidate
and integration branch are retained. The integration merge-base with
`upstream/main` must be exactly the selected stable tag. Existing upstream
contamination in `alas` must be contained by the target stable tag; otherwise
the run stops before creating an integration candidate.

Only the canonical same-version sync branch may contribute additional review
commits. Those commits are preserved and always reported as manual-review.
Older or otherwise stale sync heads are listed with their commit counts but are
never replayed automatically. The workflow updates its unprotected candidate
branches with remote-head leases; promotion is exclusively a protected PR merge
into `alas`, and protected `alas` history is never rewritten.

When the stable delta changes workflow files, the exact candidate restores the
current downstream `.github/workflows` tree and lists the upstream paths for
manual reconciliation. A push failure, canonical review edit, cherry-pick
conflict, workflow-file change, missing ledger patch, unresolved review,
release/npm mismatch, or contamination check failure makes the run fail closed.
Every path, including exceptions and push failures, writes the Actions job
summary. When the canonical PR already exists, the final `always()` step updates
its body and returns it to draft when possible.

The workflow has no GitHub Issues permission or `gh issue` calls. Its durable
operator record is:

- the Actions job summary, even after an earlier step fails;
- a failed job state for every blocked condition; and
- a persistent draft PR whenever an integration branch exists or an existing
  canonical PR can be updated.

The draft body includes release/npm verification, exact and integration
commits, patch classifications and resolutions, upstream-later exclusions,
canonical edits, stale heads, conflicts, workflow changes, and failures. Clean
candidates are marked ready and receive an explicit `ci.yml` dispatch. Stale
PRs and branches remain visible but are not sources for a newer sync. Draft
candidates must not be merged until the reported conditions are resolved.

### Manual resolution

Use the exact tag and candidate branch named in the draft PR:

```sh
tag=vX.Y.Z
branch="sync/upstream-${tag#v}"
git fetch origin

git fetch --no-tags https://github.com/agentclientprotocol/codex-acp.git \
  "+refs/tags/$tag:refs/tags/$tag" \
  '+refs/heads/main:refs/alas-upstream-main'

git switch -C "$branch" "origin/$branch"
```

Resolve only the conditions listed in the draft. The branch is already descended
from `origin/alas`; do not replace it with the exact branch or restore upstream
preview commits. Edit `docs/alas-sync-review.json` for the same `toTag` and
`toCommit`. For every `absorbed` or `overlap` patch, choose `retain`, `adapt`, or
`drop`, explain why, and list the tests that prove the decision. If code must be
adapted, commit the adapted code and review artifact together on the canonical
same-version branch. Stale sync branches are not replay sources.

Run:

```sh
npm ci
npm run test:maintenance
npm run typecheck
npm test
npm run bundle:all
npm run build
```

If `OPENAI_API_KEY` is absent, `e2e.yml` and the upstream `publish.yml`
verification job skip `npm run test:e2e` and write a visible waiver to the job
summary. Do not add or invent a secret. Push maintainer commits normally to the
canonical PR branch; do not rewrite `alas` history. Mark the draft ready only after all
manual conditions are resolved and CI passes. Never add a PAT, npm token, or
other stored publication credential.

## Manual publication

Dispatch **Publish Alas downstream** on branch `alas` with both:

- `source_commit`: the full 40-character SHA of the current protected `alas`
  head; and
- `upstream_tag`: the exact stable `vX.Y.Z` tag declared by that source.

```sh
gh workflow run publish-alas.yml --repo mrmans0n/codex-acp --ref alas \
  -f source_commit="$(git rev-parse HEAD)" \
  -f upstream_tag=vX.Y.Z
```

The workflow freshly fetches `origin/alas`, upstream tags, `upstream/main`, the
actual GitHub release, and upstream npm `latest`. It requires all of the
following:

- the GitHub release is the declared stable tag and is neither draft nor
  prerelease;
- npm `latest` equals the declared upstream version and npm `gitHead`, when
  present, equals the tag commit;
- the source is exactly the fetched protected branch head;
- the declared tag matches `package.json`'s upstream version;
- `git merge-base SOURCE_COMMIT upstream/main` is exactly that tag commit; and
- `docs/alas-sync-review.json` matches recomputed classifications for its
  `fromTag`, the declared `toTag`/`toCommit`, and contains no unresolved manual
  resolution.

The merge-base equality is intentionally stricter than an ancestry check. Any
post-tag upstream or preview commit in the source causes publication to stop,
even when the declared stable tag is also an ancestor. GitHub/npm disagreement
or a stale review artifact stops before build or publication.

After the source gate, the workflow runs `npm ci`, typecheck, unit and
maintenance tests through `npm test`, all platform bundles, and the package
build. It checks the dry-run tarball before `npm publish --provenance --tag
latest`. The `npm` environment approval remains the human publication gate.

The dependent release job creates an immutable `alas-v<version>` tag and a
GitHub release at the exact source commit. Existing matching artifacts are
accepted; tags are never moved.

## Trusted publisher setup

For a package that has never been published, first configure the npm trusted
publisher for owner `mrmans0n`, repository `codex-acp`, workflow
`publish-alas.yml`, environment `npm`, with direct publication permission.
Require 2FA and disallow traditional publish tokens. The first upload still runs
through the environment-approved workflow; do not publish interactively or use
a local npm token.

Never republish or repair an existing npm version. In particular, historical
`2.1.1-alas.1` remains immutable even though its source contains upstream
`v2.1.2-preview.1`; publish a new reviewed revision only after a clean exact-tag
source reaches `alas`.

## Recovery and rollback

If npm publication succeeds but release creation fails, rerun the failed
release job in the original Actions run. If the source is still the protected
branch head, redispatching the same source and tag reuses its published manifest
and skips the upload. Do not dispatch an old source against a newer `alas` head.

A registry error other than package-not-found stops publication. Do not replace
failed registry metadata with an empty response. If an upload outcome is
uncertain, wait for npm to expose the manifest before retrying.

Rollback by reverting the faulty downstream change in a reviewed commit and
publishing a new revision. Keep old npm versions, tags, and releases immutable
for reproducibility.

## Retirement

Retire a functional patch when a reviewed stable upstream release contains the
required behavior, or when Alas no longer needs it. Update consumers first,
then update the ledger and downstream code in the same reviewed change. Retire
the whole downstream package only after disabling `publish-alas.yml` and
removing the npm trusted publisher; preserve published versions and source
history.

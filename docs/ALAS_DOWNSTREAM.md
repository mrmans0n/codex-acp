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

Only `unaffected` functional patches are reapplied automatically. `absorbed`
and `overlap` always leave the synchronization PR in draft and fail the sync
job. A maintainer must review the stable implementation, update or retire the
ledger entry, run the full validation suite, and explicitly approve the
result. They never trigger publication.

## Stable upstream synchronization

The daily `Sync stable upstream` workflow considers only exact `vX.Y.Z` tags.
It fetches upstream tags and `upstream/main`, identifies the newest stable tag
not represented in `origin/alas`, and uses the newest stable tag already in
`alas` as the comparison base.

`scripts/sync-candidate.mjs` builds the candidate from the new stable tag's
exact commit. It does not merge or seed from `alas`, so preview or other
post-stable upstream commits present in `alas` cannot leak into the candidate.
It then:

1. classifies the functional ledger patches;
2. reapplies non-merge commits reachable from `origin/alas` but not from
   `upstream/main`, skipping ledger patches classified `absorbed` or `overlap`;
3. carries forward unique non-upstream review commits from current and older
   sync branches; and
4. verifies the candidate's merge-base with upstream history remains the exact
   stable tag.

The second step preserves fork-only maintenance commits as well as functional
patches while excluding upstream preview commits. Patch-id deduplication avoids
reapplying functional patches copied onto an older sync branch.

The canonical branch is `sync/upstream-X.Y.Z`. Rebuilding it uses an explicit
`--force-with-lease` tied to the fetched remote SHA. Every source sync branch is
checked before and after the push. When the stable delta changes workflow files,
the candidate restores the current downstream `.github/workflows` tree before
pushing and lists the upstream workflow paths for manual reconciliation; the
workflow token never needs a separate workflow-write secret. A concurrent
update, cherry-pick conflict, unique merge commit, workflow-file change, missing
ledger patch, `absorbed` classification, or `overlap` classification makes the
run fail closed. Source branches and their PRs remain intact until their
recorded heads are accounted for.

The workflow has no GitHub Issues permission or `gh issue` calls. Its durable
operator record is:

- the Actions job summary;
- a failed job state for every manual-review condition; and
- a persistent draft PR when a safe partial candidate can be pushed.

The draft body contains patch classifications, overlapping paths, conflicts,
workflow changes, merge commits, and concurrent branch changes. Clean
candidates are marked ready and receive an explicit `ci.yml` dispatch. Older
sync PRs and branches remain open so a late maintainer push stays visible; close
them manually only after confirming their latest heads are represented. Draft
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

Resolve only the conditions listed in the draft. Do not merge `origin/alas`
into the candidate and do not restore upstream preview commits. Preserve every
concurrent review commit or leave its source PR open and document why it is not
yet incorporated. For an absorbed patch, remove or update its ledger entry only
after the upstream behavior and listed tests have been reviewed. For overlap,
rework the patch against the stable tag and update its exact commit and paths.

Run:

```sh
npm ci
npm run test:maintenance
npm run typecheck
npm test
npm run bundle:all
npm run build
```

Do not run `npm run test:e2e` without `OPENAI_API_KEY`. Push with an explicit
lease, update the existing draft, and mark it ready only after all manual
conditions are resolved and CI passes. Never add a PAT, npm token, or other
stored publication credential.

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

The workflow freshly fetches `origin/alas`, the declared tag, and
`upstream/main`. `scripts/verify-alas-source.mjs` requires all of the following:

- the source is exactly the fetched protected branch head;
- the declared tag is stable and matches `package.json`'s upstream version;
- the tag resolves to the recorded upstream commit; and
- `git merge-base SOURCE_COMMIT upstream/main` is exactly that tag commit.

The final equality is intentionally stricter than an ancestry check. Any
post-tag upstream or preview commit in the source causes publication to stop,
even when the declared stable tag is also an ancestor.

After the source gate, the workflow runs `npm ci`, typecheck, unit and
maintenance tests through `npm test`, all platform bundles, and the package
build. It checks the dry-run tarball before `npm publish --provenance --tag
latest`. The `npm` environment approval remains the human publication gate.

The dependent release job creates an immutable `alas-v<version>` tag and a
GitHub release at the exact source commit. Existing matching artifacts are
accepted; tags are never moved.

## First publication and trusted publisher

For a package that has never been published, a maintainer may perform the
one-time interactive npm publication after running the same source verification
and validation locally. Configure the npm trusted publisher for owner
`mrmans0n`, repository `codex-acp`, workflow `publish-alas.yml`, environment
`npm`, with direct publication permission. Require 2FA and disallow traditional
publish tokens.

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

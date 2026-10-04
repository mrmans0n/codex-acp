# Alas downstream publication

`mrmans0n/codex-acp` maintains the `alas` branch and publishes
`@alas-ide/codex-acp`. The committed manifest keeps the upstream package name
and stable version. Publication changes only the runner's manifest to
`X.Y.Z-alas.N` and records `alasDownstream.upstreamVersion`, `upstreamCommit`,
and `sourceCommit`. The upstream commit is the canonical `vX.Y.Z` tag's commit;
it must be an ancestor of the selected source.

## First publication

1. Protect `alas`: require reviewed pull requests and passing checks, block
   force pushes and deletion, and restrict direct pushes. Configure the `npm`
   GitHub environment to allow deployments only from `alas` and require a
   maintainer approval. Put `ci.yml`, `sync-upstream.yml`, and `publish-alas.yml`
   on the fork's default branch, or make `alas` the default branch. GitHub discovers
   scheduled and manually dispatched workflows from the default branch. Enable
   these three downstream workflows and allow Actions to create pull requests.
   Keep `ci.yml` and the sync helper on `alas` too. Disable inherited upstream
   release automation, including `publish.yml`, so upstream preview and stable
   releases cannot publish from the fork. Publishing Alas is manual.
2. An npm maintainer with access to the `@alas-ide` scope signs in with 2FA.
   Check out the reviewed `alas` head, then prepare the first package:

   ```sh
   npm ci && npm run typecheck && npm test && npm run bundle:all
   upstream_version="$(node -p "require('./package.json').version")"
   git fetch https://github.com/agentclientprotocol/codex-acp.git \
     "refs/tags/v$upstream_version:refs/alas-upstream"
   upstream_commit="$(git rev-list -n 1 refs/alas-upstream)"
   git merge-base --is-ancestor "$upstream_commit" HEAD
   ALAS_UPSTREAM_VERSION="$upstream_version" \
   ALAS_UPSTREAM_COMMIT="$upstream_commit" \
   ALAS_SOURCE_COMMIT="$(git rev-parse HEAD)" \
   ALAS_PUBLISHED_JSON='[]' node scripts/prepare-alas-package.mjs
   npm run build
   npm pack --dry-run --json
   ```

   Stop on any failed command. Inspect the rewritten manifest and ensure the
   tarball contains only `dist/index.js`, `README.md`, `LICENSE`, and
   `package.json` before publishing. Use empty registry metadata only when the
   package has never been published.
3. Run `npm publish --access public --tag latest` and complete npm's 2FA prompt. This one-time
   publication creates the package so its trusted publisher can be configured.
   Run `git restore -- package.json` afterward; never commit the publication
   rewrite.
4. In the npm package's trusted publisher settings, choose GitHub Actions with
   owner `mrmans0n`, repository `codex-acp`, workflow `publish-alas.yml`, and
   environment `npm`, and grant direct publication permission. The later workflow
   publishes with provenance through OIDC. In package publishing access settings,
   require 2FA and disallow traditional publish tokens. Never store an npm publish
   token in GitHub Actions. Both manual and automated publications set `--tag latest`
   so normal installs receive the downstream version even though `-alas.N` is a
   semver prerelease.
5. Dispatch the workflow for the same source commit to create its tag and
   release. It reads the published metadata and skips the npm upload.

## Manual publication

Dispatch **Publish Alas downstream** on branch `alas`, with `source_commit` set
to the full 40-character SHA of the current protected branch head:

```sh
gh workflow run publish-alas.yml --repo mrmans0n/codex-acp --ref alas \
  -f source_commit="$(git rev-parse HEAD)"
```

Use this only from a checkout at the intended `alas` head. The workflow rejects
other branches and a source SHA that differs from freshly fetched `origin/alas`.
It runs Node 24, checks the committed lockfile before rewriting the manifest,
and checks that `dist/index.js` exists and every packed path belongs to the
manifest's `files` list. Workflow runs serialize so version allocation and npm
publication do not race. GitHub may replace an older pending run with a newer
one; dispatch the intended commit again if needed.

The npm job has only `contents: read` and `id-token: write`. The dependent tag
and release job has only `contents: write`. A successful upload or an already
published source always hands the resolved version to that job. Tags use
`alas-v<version>` and point to the exact source commit. Release notes record the
upstream tag, upstream commit, and source commit.

## Upstream synchronization and manual fallback

The daily sync merges into an existing canonical sync branch's remote head. When
replacing an older-tag PR, it starts from that PR's remote head and merges the
current `alas` branch and newest stable upstream tag. Maintainer compatibility
edits carry forward. Pushes are fast-forward only, so a concurrent update stops
the push. Older PRs close after their replacement exists and CI is dispatched;
their branches are retained to preserve edits pushed during synchronization.

`GITHUB_TOKEN` cannot push changes to `.github/workflows`. If a clean merge
changes those files, automation stops before pushing or replacing a PR and opens
or updates `Upstream synchronization required: vX.Y.Z`. Merge conflicts use the
same tracked issue. The issue names the tag, affected files, and refs to merge.
No stored PAT, App credential, or other workflow write credential is needed.

For a manual sync, use your maintainer login with permission to update workflows:

```sh
tag=vX.Y.Z                         # Use the tag named in the issue.
branch="sync/upstream-${tag#v}"
git fetch origin
git fetch --no-tags https://github.com/agentclientprotocol/codex-acp.git \
  "+refs/tags/$tag:refs/alas-upstream-tags/$tag"
```

Start from `origin/$branch` if it exists. Otherwise start from the remote head of
the older sync PR named in the issue, or `origin/alas` if no sync PR exists:

```sh
seed=origin/alas                  # Set this to the existing sync PR's remote ref.
git switch -C "$branch" "$seed"
git merge --no-edit origin/alas
# Merge any other older sync PR refs listed in the issue before the upstream tag.
git merge --no-edit "refs/alas-upstream-tags/$tag"
```

Resolve any conflicts and run `npm ci`, `npm run typecheck`, `npm test`, and
`npm run bundle:all`. Inspect workflow changes and keep inherited upstream
release automation disabled. Push with `git push origin "HEAD:refs/heads/$branch"`,
open or update its PR into `alas`, and dispatch `ci.yml` on the branch. Close older
sync PRs after the replacement succeeds; retain their branches until their latest
commits are accounted for. Never force-push over maintainer edits.

The next sync run closes tracked manual or conflict issues for tags that are
ancestors of freshly fetched `origin/alas`, including when no new sync is needed.
It also closes the older generic conflict issue when its recorded tag is merged.

## Recovery and rollback

If npm publication succeeds but tagging or release creation fails, rerun the
workflow for the same source while it remains the `alas` head. Its npm metadata
reuses the existing version and skips publishing. An existing matching tag and
release are accepted; a tag pointing elsewhere stops the job and is never moved.
If the branch has advanced, rerun only the failed release job in the original
Actions run, which retains the successful publish job's source and version.
Do not dispatch an old commit against a newer branch head.

A registry lookup error other than package-not-found stops publication. Do not
substitute empty metadata after a network or authentication failure. If an
upload's outcome is uncertain, wait until npm exposes the manifest before
rerunning. Never publish an existing version again or move a release tag.

Rollback by reverting the faulty change in a reviewed `alas` commit and
publishing a new revision. Update consumers to the resulting exact version.
Keep the old version and tag for reproducibility; npm versions are immutable.

## Retirement

Retire the downstream when upstream includes the required behavior and Alas
can use a tested upstream release, or when Alas no longer uses this adapter.
Switch consumers first, disable `publish-alas.yml`, and remove the npm trusted
publisher. Preserve published versions, tags, and their source history so
existing pinned installations remain reproducible.

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
   maintainer approval. Keep the existing upstream workflows disabled in the
   fork; publishing Alas is manual.
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
3. Run `npm publish --access public` and complete npm's 2FA prompt. This one-time
   publication creates the package so its trusted publisher can be configured.
   Run `git restore -- package.json` afterward; never commit the publication
   rewrite.
4. In the npm package's trusted publisher settings, choose GitHub Actions with
   owner `mrmans0n`, repository `codex-acp`, workflow `publish-alas.yml`, and
   environment `npm`. The later workflow publishes with provenance through OIDC;
   it needs no npm token. Remove any temporary publishing token.
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
`alas-v<version>` and point to the exact source commit.

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

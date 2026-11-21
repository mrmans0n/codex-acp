# Client-neutral Codex hook review

A client keeps its own identity and opts in through
`initialize.clientCapabilities._meta.codexHooks = {"version": 1}`.
Only version `1` is supported. Missing, non-object, array, or unknown-version
values enable nothing. The initialize answer advertises
`_meta.codexHooks = {"version": 1, "reviewToken": true}`. This opt-in does not
change tool calls or subagent reports. Actual AIR clients retain the existing
AIR hook contract even if they also supply this opt-in.

## List and trust

`_codex/hooks/list {"cwd": "/project"}` returns the existing
`{cwd, hooks, warnings, errors}` fields, restricted to `sessionFlags`, and adds:

- `reviewToken`: an opaque, non-empty string for this live app-server, cwd,
  effective hook definitions and diagnostics, and provider configuration.
- `codexHome`: the actual home reported by the app-server initialize handshake,
  omitted if unavailable. This is a directory, not an inferred local path.

Listing never writes configuration. A review with warnings or path-specific
errors remains a valid snapshot; it does not approve any hook. The client may
continue with the hooks left untrusted. A failed list supplies no review.

`_codex/hooks/trust` accepts:

```json
{
  "cwd": "/project",
  "reviewToken": "opaque-token-from-list",
  "hooks": [{"key": "session_flags:session_start:0:0", "currentHash": "reviewed-hash"}]
}
```

The response is `{"trusted": true}` only if readback reports every selected
key/hash as trusted. A false readback returns `{"trusted": false}`; write and
readback failures retain their errors. Clients must not treat any of these as
successful consent, and should list again to determine what persisted.

Before writing, the adapter requires the current token, the same full snapshot,
a non-empty selection, unique selected keys, and exactly one listed hook with
each selected key and hash. It writes only the selected `trusted_hash` entries
with `reloadUserConfig: true`, then reads Codex again. Trust-state updates alone
do not invalidate the review; definition changes do. Trust is Codex-owned
persistent state under the reported CODEX_HOME, shared with Codex CLI and other
projects using that home. Accepting another hash replaces a key's prior trust.

## Execution and recovery

Every opted-in `session/new`, `session/load`, `session/resume`, `session/fork`,
and `session/prompt` supplies:

```json
{"_meta": {"codexHooks": {"reviewToken": "opaque-token-from-list"}}}
```

The adapter carries the token in request-local asynchronous context. It checks
fresh hooks at the actual app-server `thread/start`, `thread/resume`,
`thread/fork`, `turn/start`, and `review/start` dispatch boundaries, including
a queued rollout load, lazy recovery, and internal first-turn work. A final
synchronous fence rejects a process or provider change after validation and
before dispatch. No hook-capable request is sent by a failed fence.

Tokens are adapter-local and do not survive an adapter restart, app-server
replacement, provider update, or authentication that can change routing.
Changing captured launch hooks requires a replacement process and fresh review.
A provider replacement still initializes the new process, but leaves opted-in
threads unopened until a reviewed lifecycle request or prompt resumes them.
Recovery preserves structured review errors instead of wrapping them as process
failures. A replacement-process first prompt with an old token stops before
`thread/resume` or `turn/start`.

The adapter uses JSON-RPC error code `-32044` with `data.kind`:

- `codex_hook_review_required`: missing, invalid, superseded, or wrong-process/
  provider/cwd review. List again before retrying.
- `codex_hook_changed`: changed definitions or an invalid/ambiguous selected
  identity. Refresh the displayed list and selection before trusting again.

These errors do not write trust or dispatch the blocked operation. Trust writes
are not transactional: a transport failure or failed readback after a write
must be reconciled with a fresh list. Likewise, an application retry must use
a new idempotency key after review changes if its transport caches errors.

Clients without the neutral opt-in keep their previous request/response shapes
and execution behavior. The original AIR capability and hook methods remain
compatible.

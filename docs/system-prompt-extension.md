# Session system prompt append

ACP v1 clients may send `_meta.systemPrompt.append` on `session/new`, `session/load`,
`session/resume`, and `session/fork` to install session-scoped developer
instructions. Ordinary prompts remain ordinary user messages. Codex owns tool
execution, history, and compaction; this extension does not replace its base
instructions or write instruction files.

Check the initialization response before using the extension:

```json
{"_meta":{"systemPrompt":{"version":1,"append":true,"clear":true,"maxBytes":262144}}}
```

Example session metadata:

```json
{"_meta":{"systemPrompt":{"append":"Review database migrations for this session."}}}
```

The adapter applies the append exactly like the standard ACP append-mode
`systemPrompt` with one text block (`{"mode":"append","content":[{"type":"text","text":"..."}]}`).
Clients that speak the standard field can use it instead; a request must not carry both.
The extension is offered on ACP v1 only. ACP v2 clients use the standard `systemPrompt`.

The adapter appends the client text with a blank line to AIR `customInstructions`
when present, otherwise to the effective user/project `developer_instructions` for
the requested working directory, honoring a `CODEX_CONFIG` override. The
underlying configuration is not modified. Each session gets its own value.

The adapter keeps the instructions it opened a session with while the session is
open, also across an app-server restart. A load or resume that omits the metadata,
or repeats the same text, keeps them without reloading the thread, so a client that
reconnects to a live adapter can send the same append again. A changed append on
an idle, persisted thread reloads the thread with the new instructions; they reach
the model at the next compaction, because the retained history keeps the previous
developer message. A changed append is rejected while a turn or a background
terminal runs, or when the thread has no saved rollout yet. New and forked threads
receive the instructions from their first turn.

Only the `{ "append": "..." }` form is supported. Replacement strings, unknown
fields, non-string values, and values over 256 KiB in UTF-8 are rejected before
session creation or skill changes. Config lookup failures are propagated; the
adapter never substitutes an empty configuration and loses user instructions.

The `clear: true` capability advertises explicit empty append support: `{append:""}`
restores the effective configured developer instructions (or AIR `customInstructions`),
clearing a prior session addition. Omitted metadata keeps the known instructions.

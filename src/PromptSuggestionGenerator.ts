import type {CodexAppServerClient} from "./CodexAppServerClient";

/** The `_meta` key the suggestion travels under. It names no vendor and sits outside `jetbrains.air`. */
export const PROMPT_SUGGESTIONS_META_KEY = "promptSuggestions";

// Picking the grounded next move is worth the reasoning; the sample reuses the cached conversation either way.
const SUGGESTION_EFFORT = "high";

const SUGGESTION_SCHEMA = {
    type: "object",
    properties: { suggestion: { type: ["string", "null"] } },
    required: ["suggestion"] as string[],
    additionalProperties: false,
};

// `thread/sample` takes no output schema, so the prompt carries it.
const SUGGESTION_PROMPT =
    "This is an app-generated request for a suggested next user message. The user did not write this message.\n\n" +
    "Your suggestion will appear in the user's empty message composer. They can accept it, edit it, or ignore it; it will not be sent automatically.\n\n" +
    "Predict the single message this user is most likely to type next from the visible conversation. Use the whole conversation to understand their current intent and the latest exchange. Choose the action and specific object that best continue that intent, rather than a generally useful follow-up. Express its core naturally in the user's voice, keeping the requirements needed to retain its meaning. Choose the strongest grounded move even if several continuations are possible; uncertainty about exact wording or incidental details is not a reason to return null. Use null only when the conversation offers no grounded next move at all.\n\n" +
    "Set suggestion to exactly one natural user message, one line, at most 240 characters, or null. No alternatives or explanation." +
    "\n\nReturn only JSON matching this schema: " + JSON.stringify(SUGGESTION_SCHEMA);

/** Tells whether predicted prompts are on. `CODEX_ACP_PROMPT_SUGGESTIONS=false` turns them off. */
export function promptSuggestionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env["CODEX_ACP_PROMPT_SUGGESTIONS"]?.trim().toLowerCase() !== "false";
}

/**
 * The `_meta` of the session info update that publishes `text`. `null` sends an empty list, which clears it.
 * `requestId` is the `_meta.promptSuggestions.id` of the client-neutral prompt the prediction answers.
 */
export function promptSuggestionsMeta(text: string | null, requestId?: string): Record<string, unknown> {
    return {
        [PROMPT_SUGGESTIONS_META_KEY]: {
            suggestions: text === null ? [] : [{text}],
            ...(requestId !== undefined ? {id: requestId} : {}),
        },
    };
}

/**
 * The id that a `session/prompt` names in `_meta.promptSuggestions.id` to ask for the prediction of its turn.
 * Undefined when the request names none or a value that is not a non-empty string of at most 256 characters.
 */
export function promptSuggestionsRequestId(meta: unknown): string | undefined {
    if (meta === null || typeof meta !== "object") return undefined;
    const value = (meta as Record<string, unknown>)[PROMPT_SUGGESTIONS_META_KEY];
    if (value === null || typeof value !== "object") return undefined;
    const id = (value as Record<string, unknown>)["id"];
    return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : undefined;
}

/**
 * Publishes `text` to the client; `null` clears the suggestion the client holds.
 * `requestId` names the client-neutral prompt it answers.
 */
export type PublishPromptSuggestion = (text: string | null, requestId?: string) => Promise<void>;

/**
 * Predicts the follow-up prompt of a finished turn with `thread/sample`: one model response on an ephemeral fork
 * of the session's own thread. It inherits the model and the whole conversation, so the context is a cache hit.
 */
export class PromptSuggestionGenerator {
    private generation = 0;
    private lastPublished: string | null = null;

    constructor(
        private client: CodexAppServerClient,
        private readonly publish: PublishPromptSuggestion,
    ) {}

    /**
     * Fire-and-forget hook, called after a turn ends normally. A newer turn or {@link invalidate} drops its result.
     * With a `requestId` the result always goes out with it, an empty list when the sample gives nothing or fails,
     * so a client-neutral client waiting for that id can stop.
     */
    onTurnCompleted(threadId: string, turnId: string, requestId?: string): void {
        const generation = ++this.generation;
        this.generateAndPublish(generation, threadId, turnId, requestId).catch(async () => {
            // best-effort; never surface errors to the user
            if (requestId === undefined || generation !== this.generation) return;
            await this.publishAnswer(null, requestId).catch(() => {});
        });
    }

    /** A new prompt started or the session closed: a result still being generated is dropped. */
    invalidate(): void {
        this.generation++;
    }

    /**
     * Drops a result in flight and clears the suggestion the client holds. Returns `null` when nothing is held,
     * so the caller does not wait a tick for nothing.
     */
    clear(): Promise<void> | null {
        this.invalidate();
        if (this.lastPublished === null) return null;
        return this.publishIfChanged(null).catch(() => {
            // best-effort
        });
    }

    /** The app-server restarted: later generations go to `client`. A generation in flight ends with the old one. */
    rebindAppServer(client: CodexAppServerClient): void {
        this.client = client;
    }

    private async generateAndPublish(
        generation: number,
        threadId: string,
        turnId: string,
        requestId: string | undefined,
    ): Promise<void> {
        // The app-server a generation starts on ends it, see `rebindAppServer`.
        const client = this.client;
        // The app-server rejects the sample when `turnId` is no longer the thread's latest turn.
        const response = await client.threadSample({
            threadId,
            expectedTurnId: turnId,
            prompt: SUGGESTION_PROMPT,
            effort: SUGGESTION_EFFORT,
        });

        if (generation !== this.generation) return;
        const text = parseSuggestion(response.text);
        if (requestId !== undefined) await this.publishAnswer(text, requestId);
        else await this.publishIfChanged(text);
    }

    /** Answers a client-neutral request: it goes out even when it repeats the text the client holds. */
    private async publishAnswer(text: string | null, requestId: string): Promise<void> {
        this.lastPublished = text;
        await this.publish(text, requestId);
    }

    private async publishIfChanged(text: string | null): Promise<void> {
        if (text === this.lastPublished) return;
        this.lastPublished = text;
        await this.publish(text);
    }
}

function parseSuggestion(text: string | null): string | null {
    if (!text?.trim()) return null;
    try {
        const value = (JSON.parse(text) as {suggestion?: unknown}).suggestion;
        if (typeof value !== "string") return null;
        return value.trim() || null;
    } catch {
        return null;
    }
}

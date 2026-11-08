import {AsyncLocalStorage} from "node:async_hooks";
import {createHash, randomUUID} from "node:crypto";
import {RequestError} from "@agentclientprotocol/sdk";
import type {CodexAcpClient} from "./CodexAcpClient";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {listCodexHooks, trustCodexHooks, type CodexHookIdentity} from "./CodexHookTrust";
import type {HooksListEntry} from "./app-server/v2/HooksListEntry";

export const CODEX_HOOK_REVIEW_ERROR = -32044;
export class CodexHookReviewError extends RequestError {
    constructor(kind: "codex_hook_review_required" | "codex_hook_changed") {
        super(CODEX_HOOK_REVIEW_ERROR, kind === "codex_hook_changed"
            ? "A Codex hook changed; review the startup hooks again"
            : "Review the startup hooks for the current Codex process before continuing", {kind});
    }
}

export type ReviewedCodexHooks = HooksListEntry & {reviewToken?: string; codexHome?: string};
type Review = {cwd: string; token: string; fingerprint: string; revision: number; client: CodexAppServerClient};

/** Owns ephemeral reviews. Request context also reaches lazy recovery and internal first-turn operations. */
export class CodexHookReview {
    enabled = false;
    private revision = 0;
    private readonly reviews = new Map<string, Review>();
    private readonly context = new AsyncLocalStorage<{cwd: string; token: unknown}>();

    constructor(private readonly client: () => CodexAcpClient) {}

    configure(capability: unknown, air: boolean): void {
        this.enabled = !air && typeof capability === "object" && capability !== null
            && !Array.isArray(capability) && (capability as {version?: unknown}).version === 1;
        this.invalidate();
        this.bind(this.client());
    }

    invalidate(): void {
        this.revision++;
        this.reviews.clear();
    }

    bind(client: CodexAcpClient): void {
        client.appServerClient.hookExecutionGate = this.enabled ? async cwd => {
            const context = this.context.getStore();
            if (context === undefined || (cwd !== undefined && cwd !== context.cwd)) throw new CodexHookReviewError("codex_hook_review_required");
            return await this.validate(client.appServerClient, context.cwd, context.token);
        } : undefined;
    }

    run<T>(cwd: string, meta: unknown, operation: () => Promise<T>): Promise<T> {
        if (!this.enabled) return operation();
        const hooks = (meta as {codexHooks?: {reviewToken?: unknown}} | undefined)?.codexHooks;
        return this.context.run({cwd, token: hooks?.reviewToken}, operation);
    }

    async list(cwd: string): Promise<ReviewedCodexHooks> {
        const client = this.client();
        const revision = this.revision;
        const entry = await listCodexHooks(client.appServerClient, cwd);
        if (!this.enabled) return entry;
        this.assertCurrent(client.appServerClient, revision);
        const fingerprint = definitionFingerprint(entry);
        const previous = this.reviews.get(cwd);
        const review = previous?.client === client.appServerClient && previous.revision === revision && previous.fingerprint === fingerprint
            ? previous : {cwd, token: randomUUID(), fingerprint, revision, client: client.appServerClient};
        this.reviews.set(cwd, review);
        const home = client.getHomePath();
        return {...entry, reviewToken: review.token, ...(home === null ? {} : {codexHome: home})};
    }

    async trust(cwd: string, requested: CodexHookIdentity[], token?: string): Promise<boolean> {
        const client = this.client().appServerClient;
        if (!this.enabled) return await trustCodexHooks(client, cwd, requested);
        const review = this.requireReview(client, cwd, token);
        if (requested.length === 0 || new Set(requested.map(hook => hook.key)).size !== requested.length
            || requested.some(hook => !hook.key || !hook.currentHash)) throw new CodexHookReviewError("codex_hook_changed");
        return await trustCodexHooks(client, cwd, requested, entry => {
            this.checkDefinition(client, review, entry);
            for (const request of requested) {
                const matches = entry.hooks.filter(hook => hook.key === request.key);
                if (matches.length !== 1 || matches[0]!.currentHash !== request.currentHash) {
                    throw new CodexHookReviewError("codex_hook_changed");
                }
            }
        }, () => {this.requireReview(client, cwd, token);});
    }

    private async validate(client: CodexAppServerClient, cwd: string, token: unknown): Promise<() => void> {
        const review = this.requireReview(client, cwd, token);
        const entry = await listCodexHooks(client, cwd);
        this.checkDefinition(client, review, entry);
        // The caller invokes this synchronously at dispatch, after the await and any thread-load queue.
        return () => {this.requireReview(client, cwd, token);};
    }

    private requireReview(client: CodexAppServerClient, cwd: string, token: unknown): Review {
        const review = this.reviews.get(cwd);
        if (review === undefined || typeof token !== "string" || token !== review.token || review.client !== client) {
            throw new CodexHookReviewError("codex_hook_review_required");
        }
        this.assertCurrent(client, review.revision);
        return review;
    }

    private checkDefinition(client: CodexAppServerClient, review: Review, entry: HooksListEntry): void {
        this.requireReview(client, review.cwd, review.token);
        if (definitionFingerprint(entry) !== review.fingerprint) throw new CodexHookReviewError("codex_hook_changed");
    }

    private assertCurrent(client: CodexAppServerClient, revision: number): void {
        if (client !== this.client().appServerClient || revision !== this.revision || client.connectionLoss.lost) {
            throw new CodexHookReviewError("codex_hook_review_required");
        }
    }
}

function definitionFingerprint(entry: HooksListEntry): string {
    // Trust-state changes are expected after consent; every definition field and diagnostic remains bound.
    const value = {...entry, hooks: entry.hooks.map(({trustStatus: _trust, ...definition}) => definition)};
    return createHash("sha256").update(JSON.stringify(value, (_key, value) => typeof value === "bigint" ? value.toString() : value)).digest("hex");
}

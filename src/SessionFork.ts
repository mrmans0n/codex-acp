import {createHash} from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {SessionConfig} from "./CodexAcpClient";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {ModeKind} from "./app-server/ModeKind";
import type {ServiceTier} from "./app-server/ServiceTier";
import type {Model, Turn} from "./app-server/v2";
import type {SessionMetadata} from "./SessionMetadata";
import type {AcpMcpServer, WithAcpMcpServers} from "./McpServerConfig";
import type {SessionInstructions} from "./ClientSystemPrompt";
import {renderFileCitations} from "./CodexFileCitations";

/** The top-level `_meta` key of the client-neutral fork point, see `docs/air-extensions.md`. */
export const NEUTRAL_FORK_POINT_META_KEY = "forkPoint";
export const NEUTRAL_FORK_POINT_VERSION = 1;

/** Where the history of a fork at a message ends: after the whole turn that holds the message. */
export type ForkPointBoundary = "turn";

/** The fork point that a client-neutral `session/fork` resolved, returned in the response `_meta.forkPoint`. */
export type ForkPointResult = {
    boundary: ForkPointBoundary;
    /** The id of the matched Codex item. */
    messageId: string;
    /** The last turn that the fork keeps. */
    turnId: string;
    /** The last item of that turn, the last item that the fork keeps. */
    lastItemId: string;
    matchedBy: "id" | "fingerprint";
};

/** The initialize `_meta.forkPoint` advert for a client that opted in. */
export function neutralForkPointCapability(): {version: number; boundary: ForkPointBoundary} {
    return {version: NEUTRAL_FORK_POINT_VERSION, boundary: "turn"};
}

/**
 * Whether the client opted into the client-neutral fork point with `clientCapabilities._meta.forkPoint: {version}`,
 * an integer of at least 1.
 */
export function clientRequestsNeutralForkPoint(capabilities: acp.ClientCapabilities | null | undefined): boolean {
    const declared = capabilities?._meta?.[NEUTRAL_FORK_POINT_META_KEY];
    if (!isUnknownRecord(declared)) return false;
    const version = declared["version"];
    return typeof version === "number" && Number.isInteger(version) && version >= 1;
}

/** Whether a `session/fork` request carries the client-neutral fork point. */
export function hasNeutralForkPoint(meta: Record<string, unknown> | null | undefined): boolean {
    return meta != null && meta[NEUTRAL_FORK_POINT_META_KEY] !== undefined;
}

/** The error for a client-neutral fork point from a client that did not opt in. */
export function forkPointNotNegotiatedError(): RequestError {
    return RequestError.invalidParams(
        {[NEUTRAL_FORK_POINT_META_KEY]: {reason: "notNegotiated"}},
        "session/fork _meta.forkPoint needs initialize clientCapabilities._meta.forkPoint",
    );
}

export type SessionForkDependencies = {
    codexClient: CodexAppServerClient;
    refreshSkills(cwd: string, additionalDirectories: string[]): Promise<void>;
    createSessionConfig(
        cwd: string,
        additionalDirectories: string[],
        mcpServers: AcpMcpServer[],
    ): Promise<SessionConfig>;
    getResumeModelProvider(): Promise<string>;
    fetchAvailableModels(): Promise<Model[]>;
    createCurrentModelId(models: Model[], model: string, reasoningEffort: string | null): string;
    getCollaborationMode(sessionId: string): ModeKind;
    /** Gives back the subscription of a fork that failed after `thread/fork`, unless another open of it began. */
    releaseFailedFork(threadId: string): Promise<void>;
    /** `thread/fork` answered with the thread of the fork. */
    forkCreated(threadId: string): void;
};

export async function forkSession(
    request: WithAcpMcpServers<acp.ForkSessionRequest>,
    additionalDirectories: string[],
    dependencies: SessionForkDependencies,
    instructions?: SessionInstructions,
): Promise<SessionMetadata> {
    const forkPoint = readForkPoint(request._meta);
    await dependencies.refreshSkills(request.cwd, additionalDirectories);
    const match = forkPoint ? await resolveForkPoint(request, forkPoint, dependencies.codexClient) : undefined;
    const lastTurnId = match?.turnId;
    const sessionConfig = await dependencies.createSessionConfig(
        request.cwd,
        additionalDirectories,
        request.mcpServers ?? [],
    );
    const response = await dependencies.codexClient.threadFork({
        excludeTurns: true,
        config: sessionConfig.config,
        cwd: request.cwd,
        ...(lastTurnId !== undefined && {lastTurnId}),
        modelProvider: await dependencies.getResumeModelProvider(),
        threadId: request.sessionId,
        ...(instructions?.text !== undefined ? {developerInstructions: instructions.developerInstructions} : {}),
    });
    dependencies.forkCreated(response.thread.id);
    // `thread/fork` subscribes this connection to the new thread, and only to it: the source thread keeps the
    // subscription it had. The fork stays subscribed, as ACP lets the client prompt it at once. Codex keeps an
    // unsubscribed thread loaded and runs its turns, but sends their notifications to subscribers only.
    // A fork that fails from here on has no session, so it gives the subscription back.
    let models: Model[];
    try {
        models = await dependencies.fetchAvailableModels();
    } catch (err) {
        await dependencies.releaseFailedFork(response.thread.id);
        throw err;
    }
    return {
        sessionId: response.thread.id,
        currentModelId: dependencies.createCurrentModelId(models, response.model, response.reasoningEffort),
        models,
        collaborationMode: dependencies.getCollaborationMode(response.thread.id),
        modelProvider: response.modelProvider,
        currentServiceTier: response.serviceTier as ServiceTier ?? null,
        additionalDirectories,
        skippedMcpServers: sessionConfig.skippedMcpServers,
        ...(instructions ? {instructions} : {}),
        ...(forkPoint?.kind === "neutral" && match ? {
            forkPoint: {
                boundary: "turn",
                messageId: match.messageId,
                turnId: match.turnId,
                lastItemId: match.lastItemId,
                matchedBy: match.matchedBy,
            },
        } : {}),
    };
}

type ForkPointRequest = {kind: "air" | "neutral"} & MessageForkPoint;

type ForkPointMatch = Omit<ForkPointResult, "boundary">;

/**
 * The fork point of a request. The client-neutral `_meta.forkPoint` wins over the AIR one; the caller rejects it
 * for a client that did not opt in.
 */
function readForkPoint(meta?: Record<string, unknown> | null): ForkPointRequest | undefined {
    if (hasNeutralForkPoint(meta)) return {kind: "neutral", ...readNeutralForkPoint(meta![NEUTRAL_FORK_POINT_META_KEY])};
    const air = readAirForkPoint(meta);
    return air ? {kind: "air", ...air} : undefined;
}

async function resolveForkPoint(
    request: Pick<acp.ForkSessionRequest, "sessionId" | "cwd">,
    forkPoint: ForkPointRequest,
    codexClient: CodexAppServerClient,
): Promise<ForkPointMatch> {
    const history = await codexClient.threadReadWithHistory(request.sessionId);
    const turns = history.thread.turns;
    const matchById = (candidateId: string): ForkPointMatch | undefined => {
        const turn = turns.find(turn => turn.items.some(item => item.id === candidateId));
        return turn ? toMatch(turn, candidateId, "id") : undefined;
    };
    // The AIR form also accepts the visible segment id of older AIR builds; the neutral form takes the item id.
    const candidateIds = forkPoint.kind === "air"
        ? airForkMessageIdCandidates(forkPoint.messageId)
        : [forkPoint.messageId];
    const idMatch = candidateIds.map(matchById).find(match => match !== undefined);
    if (idMatch) return idMatch;

    if (forkPoint.messageFingerprint) {
        // The client saw the text with file citations rendered, as the source session sent it.
        const renderCwd = history.thread.cwd ?? request.cwd;
        const clientText = forkPoint.kind === "neutral"
            ? (text: string) => renderFileCitations(text, renderCwd)
            : (text: string) => text;
        const matches = turns.flatMap(turn => turn.items
            .filter(item => item.type === "agentMessage"
                && fingerprintAgentMessage(clientText(item.text)) === forkPoint.messageFingerprint)
            .map(item => toMatch(turn, item.id, "fingerprint")));
        const fingerprintMatch = matches[forkPoint.messageOccurrence - 1];
        if (fingerprintMatch) return fingerprintMatch;
    }

    if (forkPoint.kind === "neutral") {
        throw RequestError.invalidParams(
            {[NEUTRAL_FORK_POINT_META_KEY]: {messageId: forkPoint.messageId, reason: "notFound"}},
            `Fork point message ${forkPoint.messageId} was not found in session ${request.sessionId}`,
        );
    }
    throw RequestError.invalidParams(
        {messageId: forkPoint.messageId},
        `Fork point message ${forkPoint.messageId} was not found in session ${request.sessionId}`,
    );
}

function toMatch(turn: Turn, messageId: string, matchedBy: ForkPointMatch["matchedBy"]): ForkPointMatch {
    return {messageId, turnId: turn.id, lastItemId: turn.items.at(-1)!.id, matchedBy};
}

/** Reads the client-neutral `_meta.forkPoint`. An invalid field fails with `{forkPoint: {field}}` as the error data. */
function readNeutralForkPoint(forkPoint: unknown): MessageForkPoint {
    const invalid = (field: string, message: string) => RequestError.invalidParams(
        {[NEUTRAL_FORK_POINT_META_KEY]: {field}},
        `session/fork _meta.forkPoint: ${message}`,
    );
    if (!isUnknownRecord(forkPoint)) throw invalid(NEUTRAL_FORK_POINT_META_KEY, "must be an object");
    const version = forkPoint["version"];
    if (version !== undefined && version !== NEUTRAL_FORK_POINT_VERSION) {
        throw invalid("version", `version must be ${NEUTRAL_FORK_POINT_VERSION} when present`);
    }
    const messageId = forkPoint["messageId"];
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
        throw invalid("messageId", "messageId must be a non-empty string");
    }
    const messageFingerprint = forkPoint["messageFingerprint"];
    if (messageFingerprint !== undefined
        && (typeof messageFingerprint !== "string" || !SHA256_FINGERPRINT.test(messageFingerprint))) {
        throw invalid("messageFingerprint", "messageFingerprint must be sha256: and 64 lowercase hex digits");
    }
    const messageOccurrence = forkPoint["messageOccurrence"] ?? 1;
    if (!Number.isSafeInteger(messageOccurrence) || (messageOccurrence as number) < 1) {
        throw invalid("messageOccurrence", "messageOccurrence must be a positive integer");
    }
    return {
        messageId: messageId.trim(),
        ...(typeof messageFingerprint === "string" && {messageFingerprint}),
        messageOccurrence: messageOccurrence as number,
    };
}

const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

type MessageForkPoint = {
    messageId: string;
    messageFingerprint?: string;
    messageOccurrence: number;
};

function readAirForkPoint(meta?: Record<string, unknown> | null): MessageForkPoint | undefined {
    const jetbrains = meta?.["jetbrains"];
    if (!isUnknownRecord(jetbrains)) return undefined;
    const air = jetbrains["air"];
    if (!isUnknownRecord(air)) return undefined;
    const fork = air["fork"];
    if (!isUnknownRecord(fork) || fork["version"] !== 1) return undefined;
    const messageId = fork["messageId"];
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
        throw RequestError.invalidParams(undefined, "AIR fork messageId must be a non-empty string");
    }
    const messageFingerprint = fork["messageFingerprint"];
    if (messageFingerprint !== undefined
        && (typeof messageFingerprint !== "string" || !SHA256_FINGERPRINT.test(messageFingerprint))) {
        throw RequestError.invalidParams(undefined, "AIR fork messageFingerprint must be a SHA-256 fingerprint");
    }
    const messageOccurrence = fork["messageOccurrence"] ?? 1;
    if (!Number.isSafeInteger(messageOccurrence) || (messageOccurrence as number) < 1) {
        throw RequestError.invalidParams(undefined, "AIR fork messageOccurrence must be a positive integer");
    }
    return {
        messageId: messageId.trim(),
        ...(typeof messageFingerprint === "string" && {messageFingerprint}),
        messageOccurrence: messageOccurrence as number,
    };
}

function fingerprintAgentMessage(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function airForkMessageIdCandidates(messageId: string): string[] {
    // Older AIR builds sent their visible segment id. Prefer the exact id before its ACP source id.
    const visibleSegmentSuffix = /:segment:\d+$/;
    const protocolMessageId = messageId.replace(visibleSegmentSuffix, "");
    return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

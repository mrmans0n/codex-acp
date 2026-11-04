/**
 * The client-neutral session failure extension, see `docs/air-extensions.md#client-neutral-session-failure`.
 */

import type * as acp from "@agentclientprotocol/sdk/unstable";

/** The top-level `_meta` key of the client-neutral session failure. */
export const NEUTRAL_SESSION_FAILURE_META_KEY = "sessionFailure";
export const SESSION_FAILURE_VERSION = 1;

/**
 * How the adapter reports failures to the client: on the legacy lane (`none`), or as typed records in the AIR
 * `sessionFailure` extension or in the client-neutral top-level `_meta.sessionFailure`.
 * Both typed forms are the same lane. They differ only in where the record goes and in its `kind`.
 */
export type SessionFailureFormat = "none" | "air" | "neutral";

/** The `initialize` answer `_meta.sessionFailure` for a client that opted into the client-neutral form. */
export function neutralSessionFailureCapability(): {version: number} {
    return {version: SESSION_FAILURE_VERSION};
}

/**
 * Whether the client opted into the client-neutral session failure with
 * `clientCapabilities._meta.sessionFailure: {version}`, an integer of at least 1.
 */
export function clientRequestsNeutralSessionFailure(capabilities: acp.ClientCapabilities | null | undefined): boolean {
    const declared: unknown = capabilities?._meta?.[NEUTRAL_SESSION_FAILURE_META_KEY];
    if (declared === null || typeof declared !== "object" || Array.isArray(declared)) return false;
    const version = (declared as Record<string, unknown>)["version"];
    return typeof version === "number" && Number.isInteger(version) && version >= 1;
}

/**
 * The incident numbers and revisions of the client-neutral form, shared by every event handler of a connection.
 *
 * A session gets a new handler for each prompt, and each `session/load` gets a new session state, while the client
 * keeps its records. Without this, a later handler can send a known id at revision 1, which the client drops,
 * or reuse the number of an unrelated incident. The AIR form keeps its per-handler numbering.
 */
export class NeutralSessionFailureLedger {
    private readonly revisions = new Map<string, number>();
    private nextIncident = 1;

    incidentNumber(): number {
        return this.nextIncident++;
    }

    /** The lowest revision of `id` that is at least `proposed` and above every revision already sent. */
    revision(id: string, proposed: number): number {
        const revision = Math.max(proposed, (this.revisions.get(id) ?? 0) + 1);
        this.revisions.set(id, revision);
        return revision;
    }
}

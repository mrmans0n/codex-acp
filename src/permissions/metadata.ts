import type * as acp from "@agentclientprotocol/sdk/unstable";
import {AIR_PERMISSION_KEY, airOnlyMeta} from "../AirExtension";
import type {ClientCapabilities} from "../tool-calls/ClientCapabilities";

export const CODEX_COMMAND_PERMISSION_TITLE = "Run command?";
export const CODEX_NETWORK_PERMISSION_TITLE = "Allow network access?";
export const CODEX_FILE_CHANGE_PERMISSION_TITLE = "Make edits?";
export const CODEX_ADDITIONAL_PERMISSIONS_TITLE = "Grant permissions?";

type RequestPermissionMetadata = {
    version: 1;
    title: string;
    description?: string;
};

type OptionPermissionMetadata = {
    version: 1;
    description: string;
};

/**
 * Private `_meta` key with the permission presentation of an ACP v2 request. The v2 renderer
 * moves it into the top-level `title`/`description` fields (`AcpV2Permissions.ts`).
 */
export const PERMISSION_PROMPT_META_KEY = "permission_prompt";

/** The top-level `_meta` key of the client-neutral permission presentation. */
export const NEUTRAL_PERMISSION_PRESENTATION_META_KEY = "permissionPresentation";
/** The top-level `_meta` key of the client-neutral question custom answer. */
export const NEUTRAL_QUESTION_CUSTOM_ANSWER_META_KEY = "questionCustomAnswer";

/** The `initialize` answer for a client that opted into a client-neutral presentation contract. */
export function neutralPresentationCapability(): {version: number} {
    return {version: 1};
}

/** Whether the client opted in with `clientCapabilities._meta[key]: {version}`, an integer of at least 1. */
export function clientRequestsNeutralPresentation(
    capabilities: acp.ClientCapabilities | null | undefined,
    key: string,
): boolean {
    const declared: unknown = capabilities?._meta?.[key];
    if (declared === null || typeof declared !== "object" || Array.isArray(declared)) return false;
    const version = (declared as Record<string, unknown>)["version"];
    return typeof version === "number" && Number.isInteger(version) && version >= 1;
}

/**
 * AIR gets the permission presentation in `_meta.jetbrains.air.permission`, and a client that opted into
 * the neutral form gets it in `_meta.permissionPresentation`.
 * On ACP v2, every client gets it as the request title and description.
 */
export function requestPermissionMeta(
    capabilities: ClientCapabilities,
    title: string,
    reason?: string | null,
): Pick<acp.RequestPermissionRequest, "_meta"> {
    const description = nonBlank(reason);
    const permission: RequestPermissionMetadata = {
        version: 1,
        title,
        ...(description ? {description} : {}),
    };
    const meta = {
        ...airOnlyMeta(capabilities.airClient, AIR_PERMISSION_KEY, permission),
        ...(capabilities.neutralPermissionPresentation ? {[NEUTRAL_PERMISSION_PRESENTATION_META_KEY]: permission} : {}),
        ...(capabilities.permissionPromptFields ? {[PERMISSION_PROMPT_META_KEY]: permission} : {}),
    };
    return Object.keys(meta).length > 0 ? {_meta: meta} : {};
}

/** Reads the presentation that `requestPermissionMeta` sets for ACP v2, if present. */
export function readPermissionMeta(
    meta: acp.RequestPermissionRequest["_meta"],
): RequestPermissionMetadata | undefined {
    const permission = meta?.[PERMISSION_PROMPT_META_KEY];
    if (typeof permission !== "object" || permission === null) return undefined;
    const {title, description} = permission as Partial<RequestPermissionMetadata>;
    if (typeof title !== "string") return undefined;
    return {version: 1, title, ...(typeof description === "string" ? {description} : {})};
}

export function optionPermissionMeta(
    capabilities: ClientCapabilities,
    description?: string | null,
): acp.PermissionOption["_meta"] | undefined {
    const normalized = nonBlank(description);
    if (!normalized) return undefined;
    const permission: OptionPermissionMetadata = {version: 1, description: normalized};
    const meta = {
        ...airOnlyMeta(capabilities.airClient, AIR_PERMISSION_KEY, permission),
        ...(capabilities.neutralPermissionPresentation ? {[NEUTRAL_PERMISSION_PRESENTATION_META_KEY]: permission} : {}),
    };
    return Object.keys(meta).length > 0 ? meta : undefined;
}

function nonBlank(value?: string | null): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

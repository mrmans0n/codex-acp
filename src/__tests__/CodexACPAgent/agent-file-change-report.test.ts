import {realpathSync} from "node:fs";
import {beforeEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import type {SessionState} from "../../CodexAcpServer";
import {ACPSessionConnection} from "../../ACPSessionConnection";
import {CodexSubagentEventRouter} from "../../subagents/CodexSubagentEventRouter";
import type {ServerNotification} from "../../app-server";
import {CodexCommands} from "../../CodexCommands";
import {logger} from "../../Logger";
import type {Turn, TurnCompletedNotification} from "../../app-server/v2";
import {AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES} from "../../AgentFileChangeReport";
import {CodexEventHandler} from "../../CodexEventHandler";

const CHILD_THREAD_ID = "child-thread";
// Use a real fixture root: /workspace may be a symlink on the test host.
const reportWorkspace = realpathSync(process.cwd());

function createTurn(id: string, status: Turn["status"]): Turn {
    return {
        id,
        items: [],
        rootTurnId: null,
        itemsView: "notLoaded",
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function promptWithFileChangeReport(
    sessionId: string,
    requestId: string,
    text = "make the change",
): acp.PromptRequest {
    return {
        sessionId,
        prompt: [{type: "text", text}],
        _meta: {
            jetbrains: {
                air: {
                    agentFileChangeReportRequest: {version: 1, requestId},
                },
            },
        },
    };
}

function reportedUpdates(fixture: CodexMockTestFixture): unknown[] {
    return fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "sessionUpdate")
        .map(event => event.args[0].update)
        .filter(update => update.sessionUpdate === "session_info_update"
            && update._meta?.jetbrains?.air?.agentFileChangeReport !== undefined);
}

const FILE_CHANGE_REPORT_CLIENT_CAPABILITIES: acp.ClientCapabilities = {
    _meta: {
        jetbrains: {
            air: {
                version: 1,
                capabilities: ["agentFileChangeReport"],
            },
        },
    },
};

function modifiedFileDiff(pathname: string): string {
    return `diff --git a/${pathname} b/${pathname}\n--- a/${pathname}\n+++ b/${pathname}\n@@ -1 +1 @@\n-old\n+new\n`;
}

function turnDiffUpdated(threadId: string, turnId: string, diff: string): ServerNotification {
    return {method: "turn/diff/updated", params: {threadId, turnId, diff}};
}

/** Notifications of a root turn that spawns a native subagent, as Codex reports them. */
function spawnChild(rootSessionId: string): ServerNotification[] {
    return [
        {
            method: "item/started",
            params: {
                threadId: rootSessionId,
                turnId: "main-turn",
                startedAtMs: 0,
                item: {
                    type: "collabAgentToolCall",
                    id: "spawn-child",
                    tool: "spawnAgent",
                    status: "inProgress",
                    senderThreadId: rootSessionId,
                    receiverThreadIds: [CHILD_THREAD_ID],
                    prompt: "Edit the docs.",
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {[CHILD_THREAD_ID]: {status: "running", message: null}},
                },
            },
        },
        {
            method: "item/started",
            params: {
                threadId: rootSessionId,
                turnId: "main-turn",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    model: null,
                    reasoningEffort: null,
                    id: "activity-child",
                    kind: "started",
                    agentThreadId: CHILD_THREAD_ID,
                    agentPath: "/root/docs_writer",
                },
            },
        },
        {method: "turn/started", params: {threadId: CHILD_THREAD_ID, turn: createTurn("child-turn", "inProgress")}},
    ];
}

function childTurnCompleted(): ServerNotification {
    return {method: "turn/completed", params: {threadId: CHILD_THREAD_ID, turn: createTurn("child-turn", "completed")}};
}

async function setupMainPrompt(
    clientCapabilities: acp.ClientCapabilities | null = FILE_CHANGE_REPORT_CLIENT_CAPABILITIES,
): Promise<{
    fixture: CodexMockTestFixture;
    sessionState: SessionState;
    turnStart: ReturnType<typeof vi.spyOn>;
    awaitTurnCompleted: ReturnType<typeof vi.spyOn>;
}> {
    const fixture = createCodexMockTestFixture();
    await fixture.getCodexAcpAgent().initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        ...(clientCapabilities === null ? {} : {clientCapabilities}),
    });
    const sessionState = createTestSessionState({
        cwd: reportWorkspace,
        additionalDirectories: ["/generated"],
    });
    vi.spyOn(fixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
    const turnStart = vi.spyOn(fixture.getCodexAppServerClient(), "turnStart")
        .mockResolvedValue({turn: createTurn("main-turn", "inProgress")});
    const awaitTurnCompleted = vi.spyOn(fixture.getCodexAppServerClient(), "awaitTurnCompleted")
        .mockResolvedValue({
            threadId: sessionState.sessionId,
            turn: createTurn("main-turn", "completed"),
        });
    return {fixture, sessionState, turnStart, awaitTurnCompleted};
}

async function setupNativeSubagentPrompt(
    clientCapabilities: acp.ClientCapabilities = {
        _meta: {jetbrains: {air: {version: 1, capabilities: ["agentFileChangeReport", "nativeSubagentSessions"]}}},
    },
): Promise<{
    fixture: CodexMockTestFixture;
    sessionState: SessionState;
    awaitTurnCompleted: ReturnType<typeof vi.spyOn>;
}> {
    const fixture = createCodexMockTestFixture();
    await fixture.getCodexAcpAgent().initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities,
    });
    const sessionState = createTestSessionState({cwd: "/workspace"});
    sessionState.subagents = new CodexSubagentEventRouter(
        sessionState.sessionId,
        true,
        new ACPSessionConnection(fixture.getAcpConnection(), sessionState.sessionId),
        () => {},
        () => ({currentModel: null, availableModels: []}),
    );
    vi.spyOn(fixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
    vi.spyOn(fixture.getCodexAppServerClient(), "turnStart")
        .mockResolvedValue({turn: createTurn("main-turn", "inProgress")});
    const awaitTurnCompleted = vi.spyOn(fixture.getCodexAppServerClient(), "awaitTurnCompleted");
    return {fixture, sessionState, awaitTurnCompleted};
}

const NEUTRAL_CAPABILITIES: acp.ClientCapabilities = {_meta: {agentFileChangeReport: {version: 1}}};

const BOTH_FORMS_CAPABILITIES: acp.ClientCapabilities = {
    _meta: {...FILE_CHANGE_REPORT_CLIENT_CAPABILITIES._meta, ...NEUTRAL_CAPABILITIES._meta},
};

const NEUTRAL_FORMS = [
    {form: "the client-neutral opt-in", capabilities: NEUTRAL_CAPABILITIES},
    {form: "both forms", capabilities: BOTH_FORMS_CAPABILITIES},
];

function neutralRequestMeta(requestId: string): Record<string, unknown> {
    return {agentFileChangeReportRequest: {version: 1, requestId}};
}

function promptWithMeta(sessionId: string, meta: Record<string, unknown>, text = "make the change"): acp.PromptRequest {
    return {sessionId, prompt: [{type: "text", text}], _meta: meta};
}

/** The neutral reports. Fails if a report also went out in the AIR namespace. */
function neutralReports(fixture: CodexMockTestFixture): unknown[] {
    const updates = fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "sessionUpdate")
        .map(event => event.args[0].update);
    expect(JSON.stringify(updates)).not.toContain('"jetbrains"');
    return updates.filter(update => update.sessionUpdate === "session_info_update"
        && update._meta?.agentFileChangeReport !== undefined);
}

function sendsDiff(
    fixture: CodexMockTestFixture,
    sessionState: SessionState,
    awaitTurnCompleted: ReturnType<typeof vi.spyOn>,
    diff: string,
): void {
    awaitTurnCompleted.mockImplementationOnce(async (): Promise<TurnCompletedNotification> => {
        fixture.sendServerNotification(turnDiffUpdated(sessionState.sessionId, "main-turn", diff));
        return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
    });
}

/** What each prompt handler still holds for the main turn when the prompt ends, just before it clears its diffs. */
function retainedMainTurnDiffs(): string[] {
    const retained: string[] = [];
    const dispose = CodexEventHandler.prototype.dispose;
    vi.spyOn(CodexEventHandler.prototype, "dispose").mockImplementation(async function (this: CodexEventHandler) {
        retained.push(this.getTurnDiff("main-turn"));
        await dispose.call(this);
    });
    return retained;
}

describe("agent file-change report lifecycle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("advertises the AIR capability to AIR", async () => {
        const fixture = createCodexMockTestFixture();
        const response = await fixture.getCodexAcpAgent().initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: []}}}},
        });

        expect(response._meta).toMatchObject({
            jetbrains: {air: {version: 1, capabilities: expect.arrayContaining(["agentFileChangeReport"])}},
        });
    });

    it("publishes the final turn diff without starting a hidden fork or turn", async () => {
        const {fixture, sessionState, turnStart, awaitTurnCompleted} = await setupMainPrompt();
        const appServer = fixture.getCodexAppServerClient();
        awaitTurnCompleted.mockImplementationOnce(async (): Promise<TurnCompletedNotification> => {
            fixture.sendServerNotification({
                method: "turn/diff/updated",
                params: {
                    threadId: sessionState.sessionId,
                    turnId: "main-turn",
                    diff: "diff --git a/src/Main.kt b/src/Main.kt\n--- a/src/Main.kt\n+++ b/src/Main.kt\n@@ -1 +1 @@\n-old\n+new\n",
                },
            });
            return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
        });
        const fork = vi.spyOn(appServer, "threadFork");

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-42"),
        )).resolves.toMatchObject({stopReason: "end_turn"});

        expect(turnStart).toHaveBeenCalledOnce();
        expect(fork).not.toHaveBeenCalled();
        expect(reportedUpdates(fixture)).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {jetbrains: {air: {
                version: 1,
                agentFileChangeReport: {
                    version: 1,
                    requestId: "request-42",
                    status: "reported",
                    paths: [`${reportWorkspace}/src/Main.kt`],
                    declaredComplete: false,
                    truncated: false,
                    uncertainty: "Codex turn diffs may omit same-content renames and changes made outside apply_patch, including shell commands, version-control commands, generators, and child processes.",
                },
            }}},
        }]);
    });

    it("uses the latest aggregated snapshot instead of merging intermediate diffs", async () => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupMainPrompt();
        awaitTurnCompleted.mockImplementationOnce(async () => {
            for (const [pathname, content] of [["first.txt", "first"], ["final.txt", "final"]]) {
                fixture.sendServerNotification({
                    method: "turn/diff/updated",
                    params: {
                        threadId: sessionState.sessionId,
                        turnId: "main-turn",
                        diff: `diff --git a/${pathname} b/${pathname}\n--- /dev/null\n+++ b/${pathname}\n@@ -0,0 +1 @@\n+${content}\n`,
                    },
                });
            }
            return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
        });

        await fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-latest"),
        );

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {paths: [`${reportWorkspace}/final.txt`]}}}},
        });
    });

    it("reports an empty incomplete list when the turn emitted no diff", async () => {
        const {fixture, sessionState} = await setupMainPrompt();

        await fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-empty"),
        );

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                status: "reported",
                paths: [],
                declaredComplete: false,
                truncated: false,
            }}}},
        });
    });

    it("reports an invalid turn diff as unavailable without failing the prompt", async () => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupMainPrompt();
        awaitTurnCompleted.mockImplementationOnce(async () => {
            fixture.sendServerNotification({
                method: "turn/diff/updated",
                params: {threadId: sessionState.sessionId, turnId: "main-turn", diff: "invalid diff"},
            });
            return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
        });
        vi.spyOn(logger, "error").mockImplementation(() => {});

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-invalid"),
        )).resolves.toMatchObject({stopReason: "end_turn"});

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                requestId: "request-invalid",
                status: "unavailable",
                reason: "invalidOutput",
            }}}},
        });
    });

    it("publishes invalidOutput without retaining an oversized turn diff", async () => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupMainPrompt();
        awaitTurnCompleted.mockImplementationOnce(async () => {
            fixture.sendServerNotification({
                method: "turn/diff/updated",
                params: {
                    threadId: sessionState.sessionId,
                    turnId: "main-turn",
                    diff: "x".repeat(AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES + 1),
                },
            });
            return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
        });

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-oversized"),
        )).resolves.toMatchObject({stopReason: "end_turn"});

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                requestId: "request-oversized",
                status: "unavailable",
                reason: "invalidOutput",
            }}}},
        });
    });

    it("ignores the request when the capability was not negotiated", async () => {
        const {fixture, sessionState} = await setupMainPrompt(null);

        await fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-ignored"),
        );

        expect(reportedUpdates(fixture)).toEqual([]);
    });

    it("publishes cancelled when the prompt is cancelled before a turn", async () => {
        const {fixture, sessionState} = await setupMainPrompt();
        const cancellation = new AbortController();
        cancellation.abort();

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-cancelled"),
            cancellation.signal,
        )).resolves.toMatchObject({stopReason: "cancelled"});

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                status: "unavailable",
                reason: "cancelled",
            }}}},
        });
    });

    it("publishes cancelled when cancellation arrives after the provider turn completes", async () => {
        const {fixture, sessionState} = await setupMainPrompt();
        const cancellation = new AbortController();
        sessionState.titleGen = {
            onTurnCompleted: () => cancellation.abort(),
        } as unknown as NonNullable<SessionState["titleGen"]>;

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-late-cancel"),
            cancellation.signal,
        )).resolves.toMatchObject({stopReason: "end_turn"});

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                status: "unavailable",
                reason: "cancelled",
            }}}},
        });
    });

    it("publishes notReported for a local command without a provider turn", async () => {
        const {fixture, sessionState} = await setupMainPrompt();
        const command = vi.spyOn(CodexCommands.prototype, "tryHandleCommand")
            .mockResolvedValue({handled: true});
        try {
            await fixture.getCodexAcpAgent().prompt(
                promptWithFileChangeReport(sessionState.sessionId, "request-local", "/status"),
            );
        } finally {
            command.mockRestore();
        }

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                status: "unavailable",
                reason: "notReported",
            }}}},
        });
    });

    it("publishes providerError when the provider turn fails to start", async () => {
        const {fixture, sessionState, turnStart} = await setupMainPrompt();
        turnStart.mockReset();
        turnStart.mockRejectedValue(new Error("provider failed"));
        vi.spyOn(logger, "error").mockImplementation(() => {});

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-provider-error"),
        )).rejects.toThrow("provider failed");

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                status: "unavailable",
                reason: "providerError",
            }}}},
        });
    });

    describe("with native subagents", () => {
        it("includes the files a subagent changed during the root turn", async () => {
            const {fixture, sessionState, awaitTurnCompleted} = await setupNativeSubagentPrompt();
            awaitTurnCompleted.mockImplementationOnce(async (): Promise<TurnCompletedNotification> => {
                for (const notification of [
                    turnDiffUpdated(sessionState.sessionId, "main-turn", modifiedFileDiff("README.md")),
                    ...spawnChild(sessionState.sessionId),
                    turnDiffUpdated(CHILD_THREAD_ID, "child-turn", modifiedFileDiff("README.md")
                        + modifiedFileDiff("community/README.md")),
                    childTurnCompleted(),
                ]) {
                    fixture.sendServerNotification(notification);
                }
                return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
            });

            await expect(fixture.getCodexAcpAgent().prompt(
                promptWithFileChangeReport(sessionState.sessionId, "request-subagent"),
            )).resolves.toMatchObject({stopReason: "end_turn"});

            expect(reportedUpdates(fixture)[0]).toMatchObject({
                _meta: {jetbrains: {air: {agentFileChangeReport: {
                    status: "reported",
                    paths: ["/workspace/README.md", "/workspace/community/README.md"],
                }}}},
            });
        });

        it("includes the files of a subagent that finishes after the root turn ends", async () => {
            const {fixture, sessionState, awaitTurnCompleted} = await setupNativeSubagentPrompt();
            awaitTurnCompleted.mockImplementationOnce(async (): Promise<TurnCompletedNotification> => {
                const completed = {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
                for (const notification of [
                    ...spawnChild(sessionState.sessionId),
                    {method: "turn/completed", params: completed} satisfies ServerNotification,
                    turnDiffUpdated(CHILD_THREAD_ID, "child-turn", modifiedFileDiff("docs/guide.md")),
                    childTurnCompleted(),
                ]) {
                    fixture.sendServerNotification(notification);
                }
                return completed;
            });

            await fixture.getCodexAcpAgent().prompt(
                promptWithFileChangeReport(sessionState.sessionId, "request-late-subagent"),
            );

            expect(reportedUpdates(fixture)[0]).toMatchObject({
                _meta: {jetbrains: {air: {agentFileChangeReport: {
                    status: "reported",
                    paths: ["/workspace/docs/guide.md"],
                }}}},
            });
        });

        it("publishes invalidOutput when a subagent turn diff is oversized", async () => {
            const {fixture, sessionState, awaitTurnCompleted} = await setupNativeSubagentPrompt();
            awaitTurnCompleted.mockImplementationOnce(async (): Promise<TurnCompletedNotification> => {
                for (const notification of [
                    ...spawnChild(sessionState.sessionId),
                    turnDiffUpdated(CHILD_THREAD_ID, "child-turn", "x".repeat(AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES + 1)),
                    childTurnCompleted(),
                ]) {
                    fixture.sendServerNotification(notification);
                }
                return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
            });

            await fixture.getCodexAcpAgent().prompt(
                promptWithFileChangeReport(sessionState.sessionId, "request-oversized-subagent"),
            );

            expect(reportedUpdates(fixture)[0]).toMatchObject({
                _meta: {jetbrains: {air: {agentFileChangeReport: {
                    status: "unavailable",
                    reason: "invalidOutput",
                }}}},
            });
        });
    });
});

describe("client-neutral agent file-change report lifecycle", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it.each(NEUTRAL_FORMS)("publishes the turn diff in the top-level form for $form", async ({capabilities}) => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupMainPrompt(capabilities);
        sendsDiff(fixture, sessionState, awaitTurnCompleted, modifiedFileDiff("src/Main.kt"));

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithMeta(sessionState.sessionId, neutralRequestMeta("request-42")),
        )).resolves.toMatchObject({stopReason: "end_turn"});

        expect(neutralReports(fixture)).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                agentFileChangeReport: {
                    version: 1,
                    requestId: "request-42",
                    status: "reported",
                    paths: [`${reportWorkspace}/src/Main.kt`],
                    declaredComplete: false,
                    truncated: false,
                    uncertainty: "Codex turn diffs may omit same-content renames and changes made outside apply_patch, including shell commands, version-control commands, generators, and child processes.",
                },
            },
        }]);
    });

    it.each(NEUTRAL_FORMS)("publishes cancelled for a prompt cancelled before a turn for $form", async ({capabilities}) => {
        const {fixture, sessionState} = await setupMainPrompt(capabilities);
        const cancellation = new AbortController();
        cancellation.abort();

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithMeta(sessionState.sessionId, neutralRequestMeta("request-cancelled")),
            cancellation.signal,
        )).resolves.toMatchObject({stopReason: "cancelled"});

        expect(neutralReports(fixture)).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {agentFileChangeReport: {
                version: 1, requestId: "request-cancelled", status: "unavailable", reason: "cancelled",
            }},
        }]);
    });

    it("publishes providerError when the provider turn fails to start", async () => {
        const {fixture, sessionState, turnStart} = await setupMainPrompt(NEUTRAL_CAPABILITIES);
        turnStart.mockReset();
        turnStart.mockRejectedValue(new Error("provider failed"));
        vi.spyOn(logger, "error").mockImplementation(() => {});

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithMeta(sessionState.sessionId, neutralRequestMeta("request-provider-error")),
        )).rejects.toThrow("provider failed");

        expect(neutralReports(fixture)).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {agentFileChangeReport: {
                version: 1, requestId: "request-provider-error", status: "unavailable", reason: "providerError",
            }},
        }]);
    });

    it("publishes providerError beside the client-neutral session failure, which keeps the prompt outcome", async () => {
        const {fixture, sessionState, turnStart} = await setupMainPrompt({
            _meta: {...NEUTRAL_CAPABILITIES._meta, sessionFailure: {version: 1}},
        });
        turnStart.mockReset();
        turnStart.mockRejectedValue(new Error("provider failed"));
        vi.spyOn(logger, "error").mockImplementation(() => {});

        const response = await fixture.getCodexAcpAgent().prompt(
            promptWithMeta(sessionState.sessionId, neutralRequestMeta("request-typed-failure")),
        );

        expect(response.stopReason).toBe("end_turn");
        expect(response._meta).toHaveProperty("sessionFailure");
        expect(response._meta).not.toHaveProperty("agentFileChangeReport");
        expect(neutralReports(fixture)).toMatchObject([
            {_meta: {agentFileChangeReport: {requestId: "request-typed-failure", reason: "providerError"}}},
        ]);
    });

    it("publishes notReported for a local command without a provider turn", async () => {
        const {fixture, sessionState} = await setupMainPrompt(NEUTRAL_CAPABILITIES);
        vi.spyOn(CodexCommands.prototype, "tryHandleCommand").mockResolvedValue({handled: true});

        await fixture.getCodexAcpAgent().prompt(
            promptWithMeta(sessionState.sessionId, neutralRequestMeta("request-local"), "/status"),
        );

        expect(neutralReports(fixture)).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {agentFileChangeReport: {
                version: 1, requestId: "request-local", status: "unavailable", reason: "notReported",
            }},
        }]);
    });

    it("publishes invalidOutput without retaining an oversized turn diff", async () => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupMainPrompt(NEUTRAL_CAPABILITIES);
        const retained = retainedMainTurnDiffs();
        sendsDiff(fixture, sessionState, awaitTurnCompleted, "x".repeat(AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES + 1));

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithMeta(sessionState.sessionId, neutralRequestMeta("request-oversized")),
        )).resolves.toMatchObject({stopReason: "end_turn"});

        expect(neutralReports(fixture)).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {agentFileChangeReport: {
                version: 1, requestId: "request-oversized", status: "unavailable", reason: "invalidOutput",
            }},
        }]);
        expect(retained).toEqual([""]);
    });

    it("includes the files a subagent changed during the root turn", async () => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupNativeSubagentPrompt({
            ...NEUTRAL_CAPABILITIES,
            subagents: {},
        } as acp.ClientCapabilities);
        awaitTurnCompleted.mockImplementationOnce(async (): Promise<TurnCompletedNotification> => {
            for (const notification of [
                turnDiffUpdated(sessionState.sessionId, "main-turn", modifiedFileDiff("README.md")),
                ...spawnChild(sessionState.sessionId),
                turnDiffUpdated(CHILD_THREAD_ID, "child-turn", modifiedFileDiff("community/README.md")),
                childTurnCompleted(),
            ]) {
                fixture.sendServerNotification(notification);
            }
            return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
        });

        await fixture.getCodexAcpAgent().prompt(
            promptWithMeta(sessionState.sessionId, neutralRequestMeta("request-subagent")),
        );

        expect(neutralReports(fixture)).toMatchObject([{
            _meta: {agentFileChangeReport: {
                status: "reported",
                paths: ["/workspace/README.md", "/workspace/community/README.md"],
            }},
        }]);
    });

    it.each([
        {form: "the AIR form", capabilities: FILE_CHANGE_REPORT_CLIENT_CAPABILITIES, meta: promptWithFileChangeReport("", "air")._meta!},
        {form: "the client-neutral form", capabilities: NEUTRAL_CAPABILITIES, meta: neutralRequestMeta("neutral")},
        {form: "both forms", capabilities: BOTH_FORMS_CAPABILITIES, meta: neutralRequestMeta("both")},
    ])("retains the turn diff for a valid request in $form", async ({capabilities, meta}) => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupMainPrompt(capabilities);
        const retained = retainedMainTurnDiffs();
        sendsDiff(fixture, sessionState, awaitTurnCompleted, modifiedFileDiff("src/Main.kt"));

        await fixture.getCodexAcpAgent().prompt(promptWithMeta(sessionState.sessionId, meta));

        expect(retained).toEqual([modifiedFileDiff("src/Main.kt")]);
    });

    it.each([
        {name: "no opt-in and a client-neutral request", capabilities: null, meta: neutralRequestMeta("ignored")},
        {name: "version 0 and a client-neutral request", capabilities: {_meta: {agentFileChangeReport: {version: 0}}}, meta: neutralRequestMeta("ignored")},
        {name: "literal true and a client-neutral request", capabilities: {_meta: {agentFileChangeReport: true}}, meta: neutralRequestMeta("ignored")},
        {name: "AIR and a client-neutral request", capabilities: FILE_CHANGE_REPORT_CLIENT_CAPABILITIES, meta: neutralRequestMeta("ignored")},
        {name: "the opt-in and an AIR request", capabilities: NEUTRAL_CAPABILITIES, meta: promptWithFileChangeReport("", "ignored")._meta!},
        {name: "both forms and an AIR request", capabilities: BOTH_FORMS_CAPABILITIES, meta: promptWithFileChangeReport("", "ignored")._meta!},
        {name: "the opt-in and no request", capabilities: NEUTRAL_CAPABILITIES, meta: {}},
        {name: "the opt-in and an unknown request version", capabilities: NEUTRAL_CAPABILITIES, meta: {agentFileChangeReportRequest: {version: 2, requestId: "ignored"}}},
        {name: "the opt-in and a malformed request id", capabilities: NEUTRAL_CAPABILITIES, meta: neutralRequestMeta("has spaces")},
        {name: "the opt-in and an extra request key", capabilities: NEUTRAL_CAPABILITIES, meta: {agentFileChangeReportRequest: {version: 1, requestId: "ignored", extra: true}}},
    ])("sends no report and collects no diff with $name", async ({capabilities, meta}) => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupMainPrompt(capabilities);
        const retained = retainedMainTurnDiffs();
        sendsDiff(fixture, sessionState, awaitTurnCompleted, modifiedFileDiff("src/Main.kt"));

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithMeta(sessionState.sessionId, meta),
        )).resolves.toMatchObject({stopReason: "end_turn"});

        expect(retained).toEqual([""]);
        expect(JSON.stringify(fixture.getAcpConnectionEvents([]))).not.toContain("agentFileChangeReport");
    });

    it.each([
        {name: "the opt-in", meta: {agentFileChangeReport: {version: 1}}},
        {name: "the opt-in and AIR", meta: {...BOTH_FORMS_CAPABILITIES._meta}},
    ])("ignores a client-neutral request on ACP v2 with $name", async ({meta}) => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupMainPrompt(null);
        await fixture.getCodexAcpAgent().initializeV2({
            protocolVersion: 2,
            info: {name: "test-client", version: "1.0.0"},
            capabilities: {_meta: meta},
        });
        const retained = retainedMainTurnDiffs();
        sendsDiff(fixture, sessionState, awaitTurnCompleted, modifiedFileDiff("src/Main.kt"));

        await fixture.getCodexAcpAgent().prompt(
            promptWithMeta(sessionState.sessionId, neutralRequestMeta("ignored")),
        );

        expect(retained).toEqual([""]);
        expect(JSON.stringify(fixture.getAcpConnectionEvents([]))).not.toContain("agentFileChangeReport");
    });
});

import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import type {McpStartupResult} from "../../mcp/McpStartupTracker";
import type {Thread, ThreadItem, Turn} from "../../app-server/v2";
import {connectSession, createThread, createTurn, sessionId, userMessageItem, type PromptSession} from "./v2-prompt-harness";

describe("ACP session fork", () => {
    it("creates and installs a forked session", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const model = createTestModel({id: "gpt-5"});

        vi.spyOn(client, "readAuthRequirement").mockResolvedValue({required: false, account: null});
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, userId: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        const forkSpy = vi.spyOn(client, "forkSession").mockResolvedValue({
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: [],
        });

        const response = await agent.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        });

        expect(response.sessionId).toBe("fork-id");
        expect(agent.getSessionState("fork-id").cwd).toBe("/workspace");
        // Forking reports the login to both standard and legacy clients.
        expect(fixture.getAcpConnectionEvents([])).toEqual([
            {
                method: "notify",
                args: ["_auth/status_update", {authStatus: {kind: "none", label: "Not logged in"}}],
            },
            {method: "notify", args: ["auth/status_update", {state: "not_required"}]},
        ]);
        expect(forkSpy).toHaveBeenCalledWith({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        }, expect.any(Function), expect.any(Function), undefined, expect.any(Function));
        // Regression pin: v1 must keep sending `modes` (v2 drops it via `forkSessionV2`).
        expect(response.modes).toBeDefined();
    });

    it("returns the resolved fork point of an opted-in client in the response _meta", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const forkPoint = {boundary: "turn", messageId: "item-1", turnId: "turn-1", lastItemId: "item-3", matchedBy: "id"} as const;

        vi.spyOn(client, "readAuthRequirement").mockResolvedValue({required: false, account: null});
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, userId: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(client, "forkSession").mockResolvedValue({
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [createTestModel({id: "gpt-5"})],
            collaborationMode: "default",
            currentServiceTier: null,
            additionalDirectories: [],
            forkPoint,
        });
        await agent.initialize({protocolVersion: 1, clientCapabilities: {_meta: {forkPoint: {version: 1}}}});

        const response = await agent.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
            _meta: {forkPoint: {messageId: "item-1"}},
        });

        expect(response._meta).toEqual({forkPoint});
    });

    it("waits for MCP startup before completing session fork", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const mcpStartup = deferred<McpStartupResult>();

        vi.spyOn(client, "readAuthRequirement").mockResolvedValue({required: false, account: null});
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, userId: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(client, "forkSession").mockResolvedValue({
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [createTestModel({id: "gpt-5"})],
            collaborationMode: "default",
            currentServiceTier: null,
            additionalDirectories: [],
        });
        const awaitMcpStartupSpy = vi.spyOn(client, "awaitMcpServerStartup")
            .mockReturnValue(mcpStartup.promise);

        const forkPromise = agent.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [{name: "fork-mcp", command: "npx", args: ["fork"], env: []}],
            _meta: {mcpStartupAwaitTimeoutMs: 30_000},
        });
        let forkSettled = false;
        void forkPromise.then(
            () => { forkSettled = true; },
            () => { forkSettled = true; },
        );

        await vi.waitFor(() => {
            expect(awaitMcpStartupSpy).toHaveBeenCalledWith(["fork-mcp"], expect.any(Number), {threadId: "fork-id", signal: expect.any(AbortSignal)});
        });
        expect(forkSettled).toBe(false);

        mcpStartup.resolve({ready: ["fork-mcp"], failed: [], cancelled: []});
        await expect(forkPromise).resolves.toMatchObject({sessionId: "fork-id", modes: expect.any(Object)});
    });

    it("leaves no MCP startup wait after a fork without the startup wait", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();

        vi.spyOn(client, "readAuthRequirement").mockResolvedValue({required: false, account: null});
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, userId: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(client, "forkSession").mockResolvedValue({
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [createTestModel({id: "gpt-5"})],
            collaborationMode: "default",
            currentServiceTier: null,
            additionalDirectories: [],
        });

        await agent.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [{name: "fork-mcp", command: "npx", args: ["fork"], env: []}],
        });

        const tracker = client.appServerClient.mcpStartup as unknown as {waiters: unknown[]};
        expect(tracker.waiters).toHaveLength(0);
    });
});

function deferred<T>(): {promise: Promise<T>, resolve: (value: T) => void} {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}

describe.each([1, 2] as const)("client-neutral fork point with session cursors, ACP v%s", version => {
    const agentItem: ThreadItem = {type: "agentMessage", id: "agent-2", text: "Answer", phase: null, memoryCitation: null, moderation: null, delivery: null, questions: null};
    const turn = (id: string, items: ThreadItem[]): Turn => ({...createTurn("completed", id), itemsView: "summary", items});
    const turns: Turn[] = [
        turn("turn-1", [userMessageItem("c1", "First")]),
        turn("turn-2", [userMessageItem("c2", "Second"), agentItem]),
        turn("turn-3", [userMessageItem("c3", "Third")]),
    ];
    let client: PromptSession;
    let forkParams: unknown[];

    async function connect() {
        const forkPoint = {_meta: {forkPoint: {version: 1}}};
        client = await connectSession(version, version === 1
            ? {v1ClientCapabilities: {session: {cursors: {}}, ...forkPoint} as never}
            : {clientCapabilities: forkPoint});
        forkParams = [];
        client.setCodexResponse("thread/turns/list", async () => ({data: turns, nextCursor: null}));
        client.setCodexResponse("thread/read", async () => ({thread: {...createThread(), turns}}));
        client.setCodexResponse("thread/fork", async params => {
            forkParams.push(params);
            const thread: Thread = createThread();
            return {thread: {...thread, id: "fork-1", sessionId: "fork-1"}, model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null};
        });
    }

    const fork = (extra: Record<string, unknown>) => client.request("session/fork", {sessionId, cwd: "/workspace", mcpServers: [], ...extra});

    it("rejects a cursorId together with the client-neutral fork point", async () => {
        await connect();
        try {
            await expect(fork({cursorId: "before:turn-3", _meta: {forkPoint: {messageId: "agent-2"}}}))
                .rejects.toMatchObject({code: -32602});
            expect(forkParams).toEqual([]);
        } finally {
            client.connection.close();
        }
    });

    it("keeps the fork at a cursor and at a fork point apart for an opted-in client", async () => {
        await connect();
        try {
            const atCursor = await fork({cursorId: "before:turn-3"});
            const atMessage = await fork({_meta: {forkPoint: {messageId: "agent-2"}}});

            expect(atCursor._meta).toBeUndefined();
            expect(atMessage._meta).toEqual({forkPoint: {boundary: "turn", messageId: "agent-2", turnId: "turn-2", lastItemId: "agent-2", matchedBy: "id"}});
            expect(forkParams).toHaveLength(2);
        } finally {
            client.connection.close();
        }
    });
});

import {afterEach, describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel, stubGatewayModelListing} from "../acp-test-utils";
import {CodexAcpClient} from "../../CodexAcpClient";
import {SYSTEM_PROMPT_CAPABILITY, withSessionInstructionAppend} from "../../SessionInstructions";
import {codexResponse, connectSession, createThread, cwd, sessionId, type PromptSession} from "./v2-prompt-harness";
import type {Thread} from "../../app-server/v2";

stubGatewayModelListing(["gpt-5"]);

function fixture(config: Record<string, any> = {}) {
    const f = createCodexMockTestFixture();
    const app = f.getCodexAppServerClient();
    const client = new CodexAcpClient(app, config);
    const thread = {id: "office-thread", historyMode: "paginated", turns: []};
    const response = {thread, model: "gpt-5", modelProvider: "openai", reasoningEffort: null,
        serviceTier: null, itemsBackwardsCursor: null};
    vi.spyOn(app, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(app, "listModels").mockResolvedValue({data: [createTestModel({id:"gpt-5"})], nextCursor: null});
    vi.spyOn(app, "configRead").mockResolvedValue({config: {developer_instructions:"user/project rules"}} as any);
    vi.spyOn(app, "threadStart").mockResolvedValue(response as any);
    vi.spyOn(app, "threadFork").mockResolvedValue(response as any);
    return {client, app};
}

const request = {cwd:"/workspace", mcpServers:[], sessionId:"office-thread"};
const metadata = {_meta: {systemPrompt: {append:"role-specific rules"}}};

describe("session instruction append through the standard systemPrompt", () => {
    for (const method of ["newSession", "forkSession"] as const) {
        it(`${method} preserves effective user rules and does not replace base instructions`, async () => {
            const {client, app} = fixture();
            await client[method](withSessionInstructionAppend({...request, ...metadata}));
            const spy = method === "newSession" ? app.threadStart : app.threadFork;
            expect(spy).toHaveBeenCalledOnce();
            const sent = vi.mocked(spy).mock.calls[0]![0];
            expect(sent.developerInstructions).toBe("user/project rules\n\nrole-specific rules");
            expect(sent).not.toHaveProperty("baseInstructions");
            expect(app.configRead).toHaveBeenCalledWith({cwd:"/workspace", includeLayers:false});
        });
        it(`${method} leaves the existing path untouched without append metadata`, async () => {
            const {client, app} = fixture();
            await client[method](withSessionInstructionAppend(request));
            const spy = method === "newSession" ? app.threadStart : app.threadFork;
            expect(vi.mocked(spy).mock.calls[0]![0]).not.toHaveProperty("developerInstructions");
        });
    }
    it("preserves CODEX_CONFIG precedence without mutating shared config or leaking to another session", async () => {
        const config = {developer_instructions:"launch rules"};
        const {client, app} = fixture(config);
        await client.newSession(withSessionInstructionAppend({...request, ...metadata}));
        await client.newSession(withSessionInstructionAppend(request));
        expect(vi.mocked(app.threadStart).mock.calls[0]![0].developerInstructions).toBe("launch rules\n\nrole-specific rules");
        expect(vi.mocked(app.threadStart).mock.calls[1]![0]).not.toHaveProperty("developerInstructions");
        expect(config).toEqual({developer_instructions:"launch rules"});
    });
    it("preserves upstream AIR-only custom instructions", async () => {
        const {client, app} = fixture();
        await client.newSession(withSessionInstructionAppend({...request, _meta:{jetbrains:{air:{customInstructions:"AIR rules"}}}}));
        expect(vi.mocked(app.threadStart).mock.calls[0]![0].developerInstructions).toBe("AIR rules");
    });
    it("appends after AIR custom instructions like the standard systemPrompt", async () => {
        const {client, app} = fixture();
        await client.newSession(withSessionInstructionAppend({...request,
            _meta:{systemPrompt:{append:"role"}, jetbrains:{air:{customInstructions:"AIR rules"}}}}));
        expect(vi.mocked(app.threadStart).mock.calls[0]![0].developerInstructions).toBe("AIR rules\n\nrole");
    });
});

const append = (text: unknown) => ({_meta: {systemPrompt: {append: text}}});
const role = append("role-specific rules");

// The downstream `_meta.systemPrompt.append` (Alas) is an ACP v1 alias of the standard append-mode
// `systemPrompt`; ACP v2 clients use the standard field only.
describe.each([1, 2] as const)("downstream session instruction append over ACP v%s", (version) => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());
    const applied = (text: string) => version === 1 ? `Configured instructions\n\n${text}` : undefined;

    async function connect() {
        const calls: Array<{method: string; params: any}> = [];
        const thread: Thread = {...createThread(), path: "/workspace/rollout.jsonl"};
        const methods = ["thread/start", "thread/resume", "thread/fork", "thread/read", "thread/unsubscribe"];
        client = await connectSession(version, {
            codexResponses: {
                "config/read": async () => ({config: {developer_instructions: "Configured instructions"}, origins: {}, layers: []}),
                "thread/backgroundTerminals/list": async () => ({data: [], nextCursor: null}),
                ...Object.fromEntries(methods.map(method => [method, async (params: any) => {
                    calls.push({method, params});
                    if (method === "thread/read") return {thread};
                    if (method === "thread/fork") {
                        return {...codexResponse("thread/start") as object, thread: {...thread, id: "fork-1"}};
                    }
                    if (method === "thread/resume" && calls.at(-2)?.method === "thread/unsubscribe") {
                        client.emit({
                            method: "thread/status/changed",
                            params: {threadId: sessionId, status: {type: "notLoaded"}},
                        } as never);
                    }
                    return codexResponse(method);
                }])),
            },
        });
        calls.length = 0;
        return calls;
    }

    it("advertises the append capability only on ACP v1", async () => {
        await connect();
        // @ts-expect-error - read the extension metadata of the initialize response of this version
        const meta = client.agent.initializeExtensionsMeta(version) as Record<string, unknown>;
        expect(meta["systemPrompt"]).toEqual(version === 1 ? SYSTEM_PROMPT_CAPABILITY : undefined);
    });

    it("appends to the configured developer instructions on session/new", async () => {
        const calls = await connect();
        await client.request("session/new", {cwd, mcpServers: [], ...role});
        expect(calls.find(call => call.method === "thread/start")?.params.developerInstructions)
            .toBe(applied("role-specific rules"));
    });

    it("applies the append on resume, load and fork", async () => {
        const calls = await connect();
        await client.request("session/resume", {sessionId, cwd, mcpServers: [], ...append("resumed role")});
        expect(calls.filter(call => call.method === "thread/resume").at(-1)?.params.developerInstructions)
            .toBe(applied("resumed role"));
        if (version === 1) {
            await client.request("session/load", {sessionId, cwd, mcpServers: [], ...append("loaded role")});
            expect(calls.filter(call => call.method === "thread/resume").at(-1)?.params.developerInstructions)
                .toBe(applied("loaded role"));
        }
        await client.request("session/fork", {sessionId, cwd, mcpServers: [], ...append("forked role")});
        expect(calls.find(call => call.method === "thread/fork")?.params.developerInstructions)
            .toBe(applied("forked role"));
    });

    it("accepts the same append again on a reconnect without reloading the thread", async () => {
        const calls = await connect();
        await client.request("session/new", {cwd, mcpServers: [], ...role});
        calls.length = 0;
        await client.request("session/resume", {sessionId, cwd, mcpServers: [], ...role});
        expect(calls.map(call => call.method)).toEqual(["thread/resume"]);
        expect(calls[0]?.params.developerInstructions).toBe(applied("role-specific rules"));
    });

    it("restores the configured rules with an explicit empty append", async () => {
        const calls = await connect();
        await client.request("session/new", {cwd, mcpServers: [], ...append("")});
        expect(calls.find(call => call.method === "thread/start")?.params.developerInstructions)
            .toBe(version === 1 ? "Configured instructions" : undefined);
    });

    it("rejects invalid append metadata on ACP v1 before any thread side effect", async () => {
        const calls = await connect();
        for (const meta of [append(42), {_meta: {systemPrompt: {append: "x", replace: true}}},
            append("x".repeat(SYSTEM_PROMPT_CAPABILITY.maxBytes + 1))]) {
            const sent = client.request("session/new", {cwd, mcpServers: [], ...meta});
            if (version === 1) await expect(sent).rejects.toMatchObject({code: -32602});
            else await sent;
        }
        expect(calls.filter(call => call.method === "thread/start").map(call => call.params.developerInstructions))
            .toEqual(version === 1 ? [] : [undefined, undefined, undefined]);
    });

    it("rejects the append together with a standard systemPrompt on ACP v1", async () => {
        const calls = await connect();
        const sent = client.request("session/new", {
            cwd, mcpServers: [], ...role,
            systemPrompt: {mode: "append", content: [{type: "text", text: "standard"}]},
        });
        if (version === 1) {
            await expect(sent).rejects.toMatchObject({code: -32602});
            expect(calls).toEqual([]);
        } else {
            await sent;
            expect(calls.find(call => call.method === "thread/start")?.params.developerInstructions)
                .toBe("Configured instructions\n\nstandard");
        }
    });
});

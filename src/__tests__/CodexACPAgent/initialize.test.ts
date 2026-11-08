import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexAcpServer } from '../../CodexAcpServer';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { createMockConnections } from './test-utils';
import {getCodexAuthMethods} from "../../CodexAuthMethod";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import packageJson from "../../../package.json";

describe('CodexACPAgent - initialize', () => {
    let agent: CodexAcpServer;
    let mockAcpConnection: any;
    let mockCodexConnection: any;

    beforeEach(() => {
        const mocks = createMockConnections();
        mockAcpConnection = mocks.mockAcpConnection;
        mockCodexConnection = mocks.mockCodexConnection;
        const codexAppServerClient = new CodexAppServerClient(mockCodexConnection);
        const codexAcpClient = new CodexAcpClient(codexAppServerClient);
        agent = new CodexAcpServer(mockAcpConnection, codexAcpClient);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should return protocol version and agent capabilities', async () => {
        const params: acp.InitializeRequest = {
            protocolVersion: acp.PROTOCOL_VERSION
        };
        const result = await agent.initialize(params);
        expect(result).toEqual({
            protocolVersion: acp.PROTOCOL_VERSION,
            agentInfo: {
                name: packageJson.name,
                title: "Codex",
                version: packageJson.version,
            },
            agentCapabilities: {
                auth: {
                    logout: {},
                },
                providers: {},
                loadSession: true,
                promptCapabilities: {
                    embeddedContext: true,
                    image: true
                },
                sessionCapabilities: {
                    resume: {},
                    list: {},
                    close: {},
                    delete: {},
                    fork: {},
                    title: {},
                    additionalDirectories: {},
                    subagents: {},
                    systemPrompt: {},
                },
                mcpCapabilities: {
                    acp: false,
                    http: true,
                    sse: false,
                },
                _meta: {
                    authStatus: {},
                },
            },
            authMethods: getCodexAuthMethods(),
            _meta: {
                systemPrompt: {version: 1, append: true, clear: true, maxBytes: 262144},
                steering: {
                    supported: true,
                },
            },
        });
    });

    it('should advertise the AIR extension only to AIR', async () => {
        const result = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: []}}, codexHooks: {version: 1}}},
        });
        expect(result._meta).toEqual({
            systemPrompt: {version: 1, append: true, clear: true, maxBytes: 262144},
            steering: {
                supported: true,
            },
            jetbrains: {
                air: {
                    version: 1,
                    goal: {
                        version: 1,
                        controlMethod: "_session/goal",
                        actions: ["set", "pause", "resume", "clear"],
                    },
                    capabilities: ["sessionFailure", "diffPatch", "agentFileChangeReport", "customInstructions", "nativeSubagentSessions", "asyncTasks", "recommendedValue", "rawInputRendering", "planContentDelta", "codexHooks"],
                },
            },
        });
    });

    it.each([undefined, null, true, {}, {version: 2}, {version: "1"}])('ignores an unsupported neutral hook capability %j', async capability => {
        const result = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {codexHooks: capability}} as never});
        expect(result._meta).not.toHaveProperty("codexHooks");
    });

    it('advertises process-bound hook review without enabling AIR', async () => {
        const result = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {codexHooks: {version: 1}}}});
        expect(result._meta?.["codexHooks"]).toEqual({version: 1, reviewToken: true});
        expect(result._meta).not.toHaveProperty("jetbrains");
    });

    it('advertises the goal extension to a non-AIR client that opts in', async () => {
        const result = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {goal: {}}},
        });

        expect(result._meta).toEqual({
            systemPrompt: {version: 1, append: true, clear: true, maxBytes: 262144},
            steering: {
                supported: true,
            },
            goal: {
                version: 1,
                controlMethod: "_session/goal",
                actions: ["set", "pause", "resume", "clear"],
            },
        });
    });

    it('advertises provider-neutral goal and async-task extensions to an opted-in client', async () => {
        const result = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {goal: {}, "async-tasks": true}},
        });

        expect(result._meta).toEqual({
            systemPrompt: {version: 1, append: true, clear: true, maxBytes: 262144},
            steering: {supported: true},
            goal: {
                version: 1,
                controlMethod: "_session/goal",
                actions: ["set", "pause", "resume", "clear"],
            },
            "async-tasks": {
                version: 1,
                controlMethod: "_session/async_task/stop",
                actions: ["stop"],
            },
        });
        expect(result._meta).not.toHaveProperty("jetbrains");
    });

    it('advertises the client-neutral session index to an opted-in client that is not AIR', async () => {
        const result = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {sessionIndex: {version: 1}}},
        });

        expect(result._meta).toEqual({
            systemPrompt: {version: 1, append: true, clear: true, maxBytes: 262144},
            steering: {supported: true},
            sessionIndex: {
                version: 1,
                capabilities: ["sessionBatchGet", "sessionArchive", "sessionRename", "sessionListSubscribe", "sessionWorktrees"],
            },
        });
    });

    it('advertises the turn-boundary fork point only to a client that opts in', async () => {
        const optedIn = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {forkPoint: {version: 1}}},
        });
        const other = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});

        expect(optedIn._meta?.["forkPoint"]).toEqual({version: 1, boundary: "turn"});
        expect(other._meta).not.toHaveProperty("forkPoint");
    });

    it('advertises the client-neutral diff patch only to a client that opts in', async () => {
        const optedIn = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {diffPatch: {version: 1}}},
        });
        const invalid = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {diffPatch: {version: "1"}}},
        });
        const other = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});

        expect(optedIn._meta?.["diffPatch"]).toEqual({version: 1, format: "git_patch"});
        expect(optedIn._meta).not.toHaveProperty("jetbrains");
        expect(invalid._meta).not.toHaveProperty("diffPatch");
        expect(other._meta).not.toHaveProperty("diffPatch");
    });

    it('keeps the AIR diffPatch advert for an AIR client and adds the client-neutral advert only when it opts in', async () => {
        const air = {jetbrains: {air: {version: 1, capabilities: ["diffPatch"]}}};
        const airOnly = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {_meta: air}});
        const both = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {...air, diffPatch: {version: 1}}},
        });

        expect(airOnly._meta).not.toHaveProperty("diffPatch");
        expect((airOnly._meta as any).jetbrains.air.capabilities).toContain("diffPatch");
        expect(both._meta?.["diffPatch"]).toEqual({version: 1, format: "git_patch"});
        expect((both._meta as any).jetbrains).toEqual((airOnly._meta as any).jetbrains);
    });

    it('advertises the client-neutral session failure only to a client that opts in', async () => {
        const optedIn = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {sessionFailure: {version: 1}}},
        });
        const later = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {sessionFailure: {version: 2}}},
        });
        const other = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});

        expect(optedIn._meta?.["sessionFailure"]).toEqual({version: 1});
        expect(optedIn._meta).not.toHaveProperty("jetbrains");
        expect(later._meta?.["sessionFailure"]).toEqual({version: 1});
        expect(other._meta).not.toHaveProperty("sessionFailure");
    });

    it.each([
        {name: "version 0", declared: {version: 0}},
        {name: "a fractional version", declared: {version: 1.5}},
        {name: "a string version", declared: {version: "1"}},
        {name: "no version", declared: {}},
        {name: "literal true", declared: true},
        {name: "an array", declared: [{version: 1}]},
        {name: "null", declared: null},
    ])('does not advertise the client-neutral session failure for $name', async ({declared}) => {
        const response = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {sessionFailure: declared}},
        });

        expect(response._meta).not.toHaveProperty("sessionFailure");
    });

    it('keeps the AIR sessionFailure advert for an AIR client and adds the client-neutral advert only when it opts in', async () => {
        const air = {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}};
        const airOnly = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {_meta: air}});
        const both = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {...air, sessionFailure: {version: 1}}},
        });

        expect(airOnly._meta).not.toHaveProperty("sessionFailure");
        expect((airOnly._meta as any).jetbrains.air.capabilities).toContain("sessionFailure");
        expect(both._meta?.["sessionFailure"]).toEqual({version: 1});
        expect((both._meta as any).jetbrains).toEqual((airOnly._meta as any).jetbrains);
    });

    it.each(['permissionPresentation', 'questionCustomAnswer', 'recommendedConfigValue', 'commandPresentation'])('advertises the client-neutral %s only to a client that opts in', async (key) => {
        const optedIn = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {[key]: {version: 2}}},
        });
        expect(optedIn._meta?.[key]).toEqual({version: 1});
        expect(optedIn._meta).not.toHaveProperty('jetbrains');
        for (const declared of [true, {}, {version: 0}, {version: 1.5}, {version: '1'}]) {
            const other = await agent.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {_meta: {[key]: declared}},
            });
            expect(other._meta).not.toHaveProperty(key);
        }
    });

    it('advertises the client-neutral agent file-change report only to a client that opts in', async () => {
        const optedIn = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {agentFileChangeReport: {version: 1}}},
        });
        const later = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {agentFileChangeReport: {version: 2}}},
        });
        const other = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});

        expect(optedIn._meta?.["agentFileChangeReport"]).toEqual({version: 1});
        expect(optedIn._meta).not.toHaveProperty("jetbrains");
        expect(later._meta?.["agentFileChangeReport"]).toEqual({version: 1});
        expect(other._meta).not.toHaveProperty("agentFileChangeReport");
    });

    it.each([
        {name: 'version 0', declared: {version: 0}},
        {name: 'a fractional version', declared: {version: 1.5}},
        {name: 'a string version', declared: {version: "1"}},
        {name: 'no version', declared: {}},
        {name: 'literal true', declared: true},
        {name: 'an array', declared: [{version: 1}]},
        {name: 'null', declared: null},
    ])('does not advertise the client-neutral agent file-change report for $name', async ({declared}) => {
        const response = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {agentFileChangeReport: declared}},
        });

        expect(response._meta).not.toHaveProperty("agentFileChangeReport");
    });

    it('keeps the AIR agentFileChangeReport advert for an AIR client and adds the client-neutral advert only when it opts in', async () => {
        const air = {jetbrains: {air: {version: 1, capabilities: ["agentFileChangeReport"]}}};
        const airOnly = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {_meta: air}});
        const both = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {...air, agentFileChangeReport: {version: 1}}},
        });

        expect(airOnly._meta).not.toHaveProperty("agentFileChangeReport");
        expect((airOnly._meta as any).jetbrains.air.capabilities).toContain("agentFileChangeReport");
        expect(both._meta?.["agentFileChangeReport"]).toEqual({version: 1});
        expect((both._meta as any).jetbrains).toEqual((airOnly._meta as any).jetbrains);
    });

    it('answers an AIR client that also sends the client-neutral session index by the AIR rules alone', async () => {
        const result = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionIndex"]}}, sessionIndex: {version: 1}}},
        });

        expect(result._meta).not.toHaveProperty("sessionIndex");
        expect((result._meta as any).jetbrains.air.capabilities)
            .toEqual(expect.arrayContaining(["sessionIndex", "sessionArchive", "sessionRename", "sessionListSubscribe"]));
    });

    it('should advertise gateway auth when the client opts into gateway auth metadata', async () => {
        const params: acp.InitializeRequest = {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
                auth: {
                    _meta: {
                        gateway: true,
                    }
                }
            }
        };

        const result = await agent.initialize(params);

        expect(result.authMethods).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "gateway",
            })
        ]));
    });

    it('enables experimental thread settings without requesting attestation', async () => {
        await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
                elicitation: { form: {}, url: {} },
            },
        });

        expect(mockCodexConnection.sendRequest).toHaveBeenCalledWith("initialize", expect.objectContaining({
            capabilities: {
                experimentalApi: true,
                requestAttestation: false,
            },
        }));
    });

    it('should advertise API key auth with the legacy metadata method', () => {
        expect(getCodexAuthMethods()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "api-key",
                _meta: {
                    "api-key": {
                        provider: "openai",
                    },
                },
            }),
        ]));
        expect(getCodexAuthMethods()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({type: "env_var"}),
            expect.objectContaining({id: "codex-api-key"}),
            expect.objectContaining({id: "openai-api-key"}),
        ]));
    });

    it('should advertise ChatGPT device code auth only when the client supports URL elicitation', () => {
        const withUrlElicitation = getCodexAuthMethods({elicitation: {url: {}}})
            .map((method) => method.id);
        expect(withUrlElicitation).toContain("chat-gpt-device-code");

        const withoutUrlElicitation = getCodexAuthMethods({elicitation: {form: {}}})
            .map((method) => method.id);
        expect(withoutUrlElicitation).not.toContain("chat-gpt-device-code");
    });

    it('should not advertise ChatGPT auth when browser auth is disabled', () => {
        const methodIds = getCodexAuthMethods(undefined, {NO_BROWSER: "1"} as NodeJS.ProcessEnv)
            .map((method) => method.id);

        expect(methodIds).not.toContain("chat-gpt");
        expect(methodIds).toEqual(expect.arrayContaining(["api-key"]));
    });
});

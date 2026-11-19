import {describe, expect, it} from "vitest";
import {readSessionInstructionAppend, SYSTEM_PROMPT_CAPABILITY, withSessionInstructionAppend} from "../SessionInstructions";
import {clientSystemPromptText} from "../ClientSystemPrompt";

describe("session instruction metadata", () => {
    it("preserves explicit empty append for native reset",()=>{expect(readSessionInstructionAppend({systemPrompt:{append:""}})).toBe("");});
    it("preserves text exactly and counts UTF-8 bytes at the boundary", () => {
        const boundary = "é".repeat(SYSTEM_PROMPT_CAPABILITY.maxBytes / 2);
        expect(readSessionInstructionAppend({systemPrompt:{append:boundary}})).toBe(boundary);
        expect(() => readSessionInstructionAppend({systemPrompt:{append:boundary + "a"}})).toThrow(/UTF-8/);
        expect(readSessionInstructionAppend({systemPrompt:{append:"  role\n"}})).toBe("  role\n");
    });
    it.each([undefined, null, {}])("ignores absent append %j", meta => {
        expect(readSessionInstructionAppend(meta)).toBeUndefined();
    });
    it.each([null, "replacement", [], {}, {append:null}, {append:42}, {append:"role",override:true}])("rejects malformed or unsupported forms %j", systemPrompt => {
        expect(() => readSessionInstructionAppend({systemPrompt})).toThrow();
    });
});

describe("session instruction append as the standard systemPrompt", () => {
    it.each(["role-specific rules", "  role\n", ""])("maps the append %j to the same append-mode text", append => {
        const request = withSessionInstructionAppend({cwd: "/workspace", _meta: {systemPrompt: {append}}}) as {systemPrompt?: unknown};
        expect(request.systemPrompt).toEqual({mode: "append", content: [{type: "text", text: append}]});
        expect(clientSystemPromptText(request.systemPrompt)).toBe(append);
    });
    it("returns a request without the metadata unchanged", () => {
        const request = {cwd: "/workspace", _meta: {other: true}};
        expect(withSessionInstructionAppend(request)).toBe(request);
    });
    it("rejects the append together with a standard systemPrompt", () => {
        expect(() => withSessionInstructionAppend({
            cwd: "/workspace",
            systemPrompt: {mode: "append", content: [{type: "text", text: "standard"}]},
            _meta: {systemPrompt: {append: "role"}},
        })).toThrow(/either systemPrompt or _meta.systemPrompt.append/);
    });
});

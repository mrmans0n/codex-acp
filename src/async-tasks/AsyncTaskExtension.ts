import type {SessionId} from "@agentclientprotocol/sdk";

export const ASYNC_TASK_STOP_METHOD = "_session/async_task/stop";
export const ASYNC_TASK_EXTENSION_VERSION = 1;
export const ASYNC_TASK_ACTIONS = ["stop"] as const;

export type AsyncTaskCapability = {
    version: typeof ASYNC_TASK_EXTENSION_VERSION;
    controlMethod: typeof ASYNC_TASK_STOP_METHOD;
    actions: typeof ASYNC_TASK_ACTIONS[number][];
};

export function asyncTaskCapability(): AsyncTaskCapability {
    return {
        version: ASYNC_TASK_EXTENSION_VERSION,
        controlMethod: ASYNC_TASK_STOP_METHOD,
        actions: [...ASYNC_TASK_ACTIONS],
    };
}

export type AsyncTaskStopRequest = {
    sessionId: SessionId;
    asyncTaskId: string;
};

export type AsyncTaskStopResponse = {
    stopped: boolean;
};

export type AsyncTaskStopExtRequest = {
    method: typeof ASYNC_TASK_STOP_METHOD;
    params: AsyncTaskStopRequest;
};

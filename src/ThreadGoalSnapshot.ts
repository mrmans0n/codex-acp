import type {ACPSessionConnection, UpdateSessionEvent} from "./ACPSessionConnection";
import {AIR_GOAL_KEY, publishAirSessionMetadata, withAirMeta} from "./AirExtension";
import {GOAL_CONTROL_METHOD, type GoalSnapshot, type GoalStatus} from "./GoalExtension";
import type {ThreadGoal} from "./app-server/v2";
import type {ClientCapabilities} from "./tool-calls/ClientCapabilities";

export type ThreadGoalSnapshot = GoalSnapshot;

function toGoalStatus(status: ThreadGoal["status"]): GoalStatus {
    switch (status) {
        case "active":
        case "paused":
        case "blocked":
        case "complete":
            return status;
        case "usageLimited":
        case "budgetLimited":
            return "limited";
    }
}

function toUnixMilliseconds(timestampSeconds: number): number {
    return timestampSeconds * 1000;
}

export function toThreadGoalSnapshot(goal: ThreadGoal): ThreadGoalSnapshot {
    return {
        objective: goal.objective.trim(),
        status: toGoalStatus(goal.status),
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        createdAt: toUnixMilliseconds(goal.createdAt),
        updatedAt: toUnixMilliseconds(goal.updatedAt),
        controlMethod: GOAL_CONTROL_METHOD,
    };
}

export function sameThreadGoalSnapshot(
    left: ThreadGoalSnapshot | null | undefined,
    right: ThreadGoalSnapshot | null,
): boolean {
    if (left === undefined) return false;
    if (left === null || right === null) return left === right;
    return left.objective === right.objective
        && left.status === right.status
        && left.tokenBudget === right.tokenBudget
        && left.createdAt === right.createdAt;
}

export function goalSessionInfoUpdate(
    goal: ThreadGoalSnapshot | null,
    capabilities: ClientCapabilities,
): UpdateSessionEvent | null {
    if (!capabilities.goal) return null;
    return {
        sessionUpdate: "session_info_update",
        _meta: capabilities.airClient
            ? withAirMeta(undefined, AIR_GOAL_KEY, goal)
            : {[AIR_GOAL_KEY]: goal},
    };
}

/** AIR composes its namespace; a client that opts in to `_meta.goal` (ACP v1 only) gets a plain update. */
export function publishGoalSessionInfo(
    session: ACPSessionConnection,
    goal: ThreadGoalSnapshot | null,
    capabilities: ClientCapabilities,
): Promise<void> {
    if (capabilities.airClient) return publishAirSessionMetadata(session, AIR_GOAL_KEY, goal);
    const update = goalSessionInfoUpdate(goal, capabilities);
    return update === null ? Promise.resolve() : session.update(update);
}

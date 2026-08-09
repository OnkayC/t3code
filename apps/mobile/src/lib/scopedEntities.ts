import { ApprovalRequestId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export function scopedProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

export function scopedThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

export function scopedRequestKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: ApprovalRequestId | string,
): string {
  return `${environmentId}:${threadId}:${requestId}`;
}

import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

export interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  allowedDecisions?: ReadonlyArray<ProviderApprovalDecision> | undefined;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  allowedDecisions,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const allowed = allowedDecisions ?? ["cancel", "decline", "acceptForSession", "accept"];
  return (
    <>
      {allowed.includes("cancel") ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "cancel")}
        >
          Cancel turn
        </Button>
      ) : null}
      {allowed.includes("decline") ? (
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "decline")}
        >
          Decline
        </Button>
      ) : null}
      {allowed.includes("acceptForSession") ? (
        <Button
          size="sm"
          variant="outline"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
        >
          Always allow this session
        </Button>
      ) : null}
      {allowed.includes("accept") ? (
        <Button
          size="sm"
          variant="default"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "accept")}
        >
          Approve once
        </Button>
      ) : null}
    </>
  );
});

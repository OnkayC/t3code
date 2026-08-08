import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

export interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  allowedDecisions?: ReadonlyArray<ProviderApprovalDecision> | undefined;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const APPROVAL_ACTION_CLASS_NAME = "font-normal";
const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;
const ALWAYS_ALLOW_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptAlways", label: "Always allow" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  allowedDecisions,
  isResponding,
  options,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const allowed = allowedDecisions ??
    options?.map((option) => option.decision) ?? [
      "cancel",
      "decline",
      "acceptForSession",
      "accept",
    ];
  const resolvedOptions =
    options ??
    (allowed.includes("acceptAlways") ? ALWAYS_ALLOW_APPROVAL_OPTIONS : DEFAULT_APPROVAL_OPTIONS);
  return (
    <>
      {resolvedOptions
        .filter((option) => allowed.includes(option.decision))
        .map((option) => (
          <Button
            key={option.decision}
            size="micro"
            variant="ghost-muted"
            className={`${APPROVAL_ACTION_CLASS_NAME}${
              option.decision === "decline"
                ? " text-destructive-foreground [:hover,[data-pressed]]:text-destructive-foreground"
                : option.decision === "accept"
                  ? " text-foreground"
                  : ""
            }`}
            disabled={isResponding}
            onClick={() => void onRespondToApproval(requestId, option.decision)}
          >
            <span className="max-w-40 truncate">{option.label}</span>
          </Button>
        ))}
    </>
  );
});

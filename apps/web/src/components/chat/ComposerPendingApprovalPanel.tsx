import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { Badge } from "../ui/badge";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    approval.requestKind === "command"
      ? "Command approval requested"
      : approval.requestKind === "file-read"
        ? "File-read approval requested"
        : approval.requestKind === "file-change"
          ? "File-change approval requested"
          : `${approval.toolName ?? "Tool"} approval requested`;
  const detailLabel =
    approval.requestKind === "command"
      ? "Command"
      : approval.requestKind === "file-read"
        ? "File to read"
        : approval.requestKind === "file-change"
          ? "File change"
          : "Request details";
  const argumentsText = approval.args === undefined ? null : JSON.stringify(approval.args, null, 2);

  return (
    <div className="min-w-0 px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
        {approval.tier ? <Badge variant="outline">{approval.tier}</Badge> : null}
        {approval.approvalMode ? <Badge variant="secondary">{approval.approvalMode}</Badge> : null}
      </div>
      {approval.reason ? (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{approval.reason}</p>
      ) : null}
      {argumentsText ? (
        <div className="mt-3 rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">Arguments</p>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
            {argumentsText}
          </pre>
        </div>
      ) : null}
      {approval.details && approval.details.length > 0 ? (
        <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
          {approval.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      {approval.providerSafetyChecks && approval.providerSafetyChecks.length > 0 ? (
        <div className="mt-3 rounded-lg border border-warning/35 bg-warning/8 p-3">
          <p className="text-xs font-medium text-warning-foreground">Provider safety checks</p>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-xs text-warning-foreground/85">
            {approval.providerSafetyChecks.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {approval.detail ? (
        <div className="mt-3 min-w-0 max-w-full rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">{detailLabel}</p>
          <pre
            aria-label={detailLabel}
            className="mt-2 min-w-0 max-w-full max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-relaxed text-foreground"
            data-approval-detail="complete"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
});

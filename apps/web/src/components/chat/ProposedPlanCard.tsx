import { memo, useEffect, useState, useId } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  TurnId,
  type EnvironmentId,
  type ProviderPlanReviewContextStrategy,
  type ProviderPlanReviewDecision,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { PendingPlanReview } from "../../session-logic";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  environmentId,
  threadRef,
  cwd,
  workspaceRoot,
  planReview,
  isReviewResponding = false,
  onRespondToPlanReview,
}: {
  planMarkdown: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  planReview?: PendingPlanReview | null;
  isReviewResponding?: boolean;
  onRespondToPlanReview?: (decision: ProviderPlanReviewDecision) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const [reviewContext, setReviewContext] = useState<ProviderPlanReviewContextStrategy>(
    planReview?.allowedContextStrategies[0] ?? "fresh",
  );
  const [executionModelKey, setExecutionModelKey] = useState(() => {
    const model = planReview?.defaultExecutionModel ?? planReview?.executionModels[0];
    return model ? `${model.provider}:${model.modelId}:${model.thinkingLevel ?? ""}` : "";
  });
  const [refineFeedback, setRefineFeedback] = useState("");
  useEffect(() => {
    setReviewContext(planReview?.allowedContextStrategies[0] ?? "fresh");
    const model = planReview?.defaultExecutionModel ?? planReview?.executionModels[0];
    setExecutionModelKey(
      model ? `${model.provider}:${model.modelId}:${model.thinkingLevel ?? ""}` : "",
    );
    setRefineFeedback("");
  }, [planReview?.requestId]);

  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "plan",
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy plan",
          description: error instanceof Error ? error.message : "An error occurred while copying.",
        }),
      );
    },
  });
  const savePathInputId = useId();
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Workspace path is unavailable",
          description: "This thread does not have a workspace path to save into.",
        }),
      );
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const relativePath = savePath.trim();
    if (!workspaceRoot) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "Enter a workspace path",
      });
      return;
    }

    setIsSavingToWorkspace(true);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath,
          contents: saveContents,
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "Plan saved to workspace",
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred while saving.",
          }),
        );
      }
    })();
  };

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? "Copied!" : "Copy to clipboard"}
            </MenuItem>
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>

      {planReview && onRespondToPlanReview ? (
        <div className="mt-5 border-t border-border/70 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-foreground">Review this plan</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Execute, request a refinement, or cancel without leaving this thread.
              </p>
            </div>
            {(() => {
              // Allow only http(s) artifact links — never javascript:/file:/local: schemes.
              const raw = planReview.planArtifactUrl;
              if (typeof raw !== "string" || raw.length === 0) return null;
              try {
                const parsed = new URL(raw);
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
                return (
                  <a
                    href={parsed.href}
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Open artifact
                  </a>
                );
              } catch {
                return null;
              }
            })()}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Execution context
              <Select
                value={reviewContext}
                onValueChange={(value) => value && setReviewContext(value)}
                disabled={isReviewResponding}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {planReview.allowedContextStrategies.map((strategy) => (
                    <SelectItem key={strategy} value={strategy}>
                      {strategy === "fresh"
                        ? "Fresh context"
                        : strategy === "preserve"
                          ? "Preserve context"
                          : "Compact, then execute"}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            {planReview.executionModels.length > 0 ? (
              <label className="grid gap-1.5 text-xs font-medium text-foreground">
                Execution model
                <Select
                  value={executionModelKey}
                  onValueChange={(value) => value && setExecutionModelKey(value)}
                  disabled={isReviewResponding}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Default model" />
                  </SelectTrigger>
                  <SelectPopup>
                    {planReview.executionModels.map((model) => {
                      const key = `${model.provider}:${model.modelId}:${model.thinkingLevel ?? ""}`;
                      return (
                        <SelectItem key={key} value={key}>
                          {model.provider} / {model.modelId}
                          {model.thinkingLevel ? ` · ${model.thinkingLevel}` : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectPopup>
                </Select>
              </label>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={isReviewResponding}
              onClick={() => onRespondToPlanReview({ action: "cancel" })}
            >
              Cancel review
            </Button>
            <Button
              size="sm"
              disabled={isReviewResponding}
              onClick={() => {
                const executionModel = planReview.executionModels.find(
                  (model) =>
                    `${model.provider}:${model.modelId}:${model.thinkingLevel ?? ""}` ===
                    executionModelKey,
                );
                onRespondToPlanReview({
                  action: "execute",
                  context: reviewContext,
                  ...(executionModel ? { executionModel } : {}),
                  clientTurnId: TurnId.make(
                    `turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                  ),
                });
              }}
            >
              Execute plan
            </Button>
          </div>
          <div className="mt-4 grid gap-2">
            <Textarea
              value={refineFeedback}
              onChange={(event) => setRefineFeedback(event.target.value)}
              placeholder="What should change before execution?"
              disabled={isReviewResponding}
              className="min-h-20 resize-y text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              className="justify-self-end"
              disabled={isReviewResponding || refineFeedback.trim().length === 0}
              onClick={() =>
                onRespondToPlanReview({
                  action: "refine",
                  feedback: refineFeedback.trim(),
                  clientTurnId: TurnId.make(
                    `turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                  ),
                })
              }
            >
              Request refinement
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderPlanReviewDecision,
  type ProviderUserInputResponse,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  createPlanReviewResponseCoordinator,
  foldProviderInteractionActivities,
  samePlanReviewResponseScope,
  type PlanReviewResponseScope,
  type ProviderQueuedTurn,
} from "@t3tools/client-runtime/state/providerInteractionRuntime";
import { Atom } from "effect/unstable/reactivity";

import { threadEnvironment } from "../state/threads";
import { scopedRequestKey } from "../lib/scopedEntities";
import {
  buildPendingUserInputAnswers,
  derivePendingApprovals,
  derivePendingPlanReview,
  derivePendingUserInputs,
  setPendingUserInputCustomAnswer,
  setPendingUserInputNote,
  sortThreadActivities,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import { appAtomRegistry } from "./atom-registry";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";
import {
  addPlanReviewResponseScope,
  reconcileCancellingQueuedTurnIds,
  removePlanReviewResponseScope,
} from "./selected-thread-request-guards";

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

function setUserInputDraftOption(
  requestKey: string,
  question: UserInputQuestion,
  label: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        current[requestKey]?.[question.id],
        label,
      ),
    },
  });
}

function setUserInputDraftCustomAnswer(
  requestKey: string,
  questionId: string,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [questionId]: setPendingUserInputCustomAnswer(
        current[requestKey]?.[questionId],
        customAnswer,
      ),
    },
  });
}

function setUserInputDraftNote(requestKey: string, questionId: string, note: string): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [questionId]: setPendingUserInputNote(current[requestKey]?.[questionId], note),
    },
  });
}

export function useSelectedThreadRequests() {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const respondToPlanReview = useAtomCommand(
    threadEnvironment.respondToPlanReview,
    "thread plan review response",
  );
  const cancelQueuedTurn = useAtomCommand(
    threadEnvironment.cancelQueuedTurn,
    "thread cancel queued turn",
  );
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );
  // Preserve every env/thread/request scope while its response is in flight;
  // switching threads must not re-enable a card the coordinator still guards.
  const [respondingPlanReviewScopes, setRespondingPlanReviewScopes] = useState<
    ReadonlyArray<PlanReviewResponseScope>
  >([]);
  const [cancellingQueuedTurnIds, setCancellingQueuedTurnIds] = useState<ReadonlyArray<string>>([]);
  const [planReviewResponseCoordinator] = useState(createPlanReviewResponseCoordinator);

  const sortedActivities = useMemo(
    () => (selectedThread ? sortThreadActivities(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingApproval = useMemo(
    () => derivePendingApprovals(sortedActivities)[0] ?? null,
    [sortedActivities],
  );
  const activePendingUserInput = useMemo(
    () => derivePendingUserInputs(sortedActivities)[0] ?? null,
    [sortedActivities],
  );
  const activePendingPlanReview = useMemo(
    () => derivePendingPlanReview(sortedActivities),
    [sortedActivities],
  );
  const providerInteractionState = useMemo(
    () => foldProviderInteractionActivities(sortedActivities),
    [sortedActivities],
  );
  const queuedTurns = providerInteractionState.queuedTurns;
  useEffect(() => {
    setCancellingQueuedTurnIds((current) =>
      reconcileCancellingQueuedTurnIds(
        current,
        queuedTurns.map((queuedTurn) => queuedTurn.turnId),
      ),
    );
  }, [queuedTurns]);
  useEffect(() => {
    if (!selectedThreadShell) return;
    if (
      planReviewResponseCoordinator.reconcile({
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        requestId: activePendingPlanReview?.requestId ?? null,
      })
    ) {
      setRespondingPlanReviewScopes((current) =>
        current.filter(
          (scope) =>
            scope.environmentId !== selectedThreadShell.environmentId ||
            scope.threadId !== selectedThreadShell.id ||
            scope.requestId === activePendingPlanReview?.requestId,
        ),
      );
    }
  }, [activePendingPlanReview, planReviewResponseCoordinator, selectedThreadShell]);
  // Reactor respond.failed is nonterminal (review stays open). Release the
  // in-flight guard so the card is retryable after timeouts/errors.
  useEffect(() => {
    if (!selectedThreadShell) return;
    const failure = providerInteractionState.lastPlanReviewRespondFailure;
    if (!failure) return;
    const responseScope: PlanReviewResponseScope = {
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      requestId: failure.requestId,
    };
    if (planReviewResponseCoordinator.fail(responseScope)) {
      setRespondingPlanReviewScopes((current) =>
        removePlanReviewResponseScope(current, responseScope),
      );
    }
  }, [
    planReviewResponseCoordinator,
    providerInteractionState.lastPlanReviewRespondFailure,
    selectedThreadShell,
  ]);
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedThreadShell
      ? (userInputDraftsByRequestKey[
          scopedRequestKey(
            selectedThreadShell.environmentId,
            selectedThreadShell.id,
            activePendingUserInput.requestId,
          )
        ] ?? {})
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(
        activePendingUserInput.questions,
        activePendingUserInputDrafts,
        activePendingUserInput.supportsNote === true,
      )
    : null;

  const onSelectUserInputOption = useCallback(
    (requestId: ApprovalRequestId, question: UserInputQuestion, label: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(
        selectedThreadShell.environmentId,
        selectedThreadShell.id,
        requestId,
      );
      setUserInputDraftOption(requestKey, question, label);
    },
    [activePendingUserInput, selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: ApprovalRequestId, questionId: string, customAnswer: string) => {
      if (!selectedThreadShell) return;
      setUserInputDraftCustomAnswer(
        scopedRequestKey(selectedThreadShell.environmentId, selectedThreadShell.id, requestId),
        questionId,
        customAnswer,
      );
    },
    [selectedThreadShell],
  );

  const onChangeUserInputNote = useCallback(
    (requestId: ApprovalRequestId, questionId: string, note: string) => {
      if (!selectedThreadShell) return;
      setUserInputDraftNote(
        scopedRequestKey(selectedThreadShell.environmentId, selectedThreadShell.id, requestId),
        questionId,
        note,
      );
    },
    [selectedThreadShell],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!selectedThreadShell) return;
      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: selectedThreadShell.environmentId,
        input: { threadId: selectedThreadShell.id, requestId, decision },
      });
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [respondToApproval, selectedThreadShell],
  );

  const onRespondToUserInput = useCallback(
    async (response: ProviderUserInputResponse) => {
      if (!selectedThreadShell || !activePendingUserInput) return;
      if (response.kind === "submit" && !activePendingUserInputAnswers) return;
      setRespondingUserInputId(activePendingUserInput.requestId);
      const result = await respondToUserInput({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId: activePendingUserInput.requestId,
          response,
        },
      });
      setRespondingUserInputId((current) =>
        current === activePendingUserInput.requestId ? null : current,
      );
      return result;
    },
    [
      activePendingUserInput,
      activePendingUserInputAnswers,
      respondToUserInput,
      selectedThreadShell,
    ],
  );

  const onRespondToPlanReview = useCallback(
    async (decision: ProviderPlanReviewDecision) => {
      if (!selectedThreadShell || !activePendingPlanReview) return;
      const requestId = activePendingPlanReview.requestId;
      const responseScope: PlanReviewResponseScope = {
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        requestId,
      };
      if (!planReviewResponseCoordinator.begin(responseScope)) return;
      setRespondingPlanReviewScopes((current) =>
        addPlanReviewResponseScope(current, responseScope),
      );
      const result = await respondToPlanReview({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId,
          decision,
        },
      });
      if (result._tag === "Failure") {
        planReviewResponseCoordinator.fail(responseScope);
        setRespondingPlanReviewScopes((current) =>
          removePlanReviewResponseScope(current, responseScope),
        );
      }
      return result;
    },
    [
      activePendingPlanReview,
      planReviewResponseCoordinator,
      respondToPlanReview,
      selectedThreadShell,
    ],
  );

  const onCancelQueuedTurn = useCallback(
    async (turnId: string) => {
      if (!selectedThreadShell) return;
      setCancellingQueuedTurnIds((existing) =>
        existing.includes(turnId) ? existing : [...existing, turnId],
      );
      const result = await cancelQueuedTurn({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          turnId: TurnId.make(turnId),
        },
      });
      if (result._tag === "Failure") {
        setCancellingQueuedTurnIds((existing) => existing.filter((id) => id !== turnId));
      }
      return result;
    },
    [cancelQueuedTurn, selectedThreadShell],
  );
  const respondingPlanReviewScope =
    selectedThreadShell && activePendingPlanReview
      ? (respondingPlanReviewScopes.find((scope) =>
          samePlanReviewResponseScope(scope, {
            environmentId: selectedThreadShell.environmentId,
            threadId: selectedThreadShell.id,
            requestId: activePendingPlanReview.requestId,
          }),
        ) ?? null)
      : null;

  return {
    activePendingApproval,
    activePendingUserInput,
    activePendingPlanReview,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    queuedTurns: queuedTurns as ReadonlyArray<ProviderQueuedTurn>,
    cancellingQueuedTurnIds,
    respondingApprovalId,
    respondingUserInputId,
    respondingPlanReviewScope,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onChangeUserInputNote,
    onRespondToUserInput,
    onRespondToPlanReview,
    onCancelQueuedTurn,
  };
}

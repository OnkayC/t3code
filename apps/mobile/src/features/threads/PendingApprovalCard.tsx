import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderApprovalOption,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly approval: PendingApproval;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

const EXTENDED_APPROVAL_OPTIONS = [
  ...DEFAULT_APPROVAL_OPTIONS.slice(0, 2),
  { decision: "acceptAlways", label: "Always allow" },
  DEFAULT_APPROVAL_OPTIONS[2],
  { decision: "cancel", label: "Cancel turn" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const allowed =
    props.approval.allowedDecisions ??
    props.approval.options?.map((option) => option.decision) ??
    DEFAULT_APPROVAL_OPTIONS.map((option) => option.decision);
  const fallbackOptions = props.approval.allowedDecisions
    ? EXTENDED_APPROVAL_OPTIONS
    : DEFAULT_APPROVAL_OPTIONS;
  const options = (props.approval.options ?? fallbackOptions).filter((option) =>
    allowed.includes(option.decision),
  );
  const argumentsText =
    props.approval.args === undefined ? null : JSON.stringify(props.approval.args, null, 2);
  const title = props.approval.appName ?? props.approval.toolName ?? props.approval.requestKind;
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        Approval needed
      </Text>
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">{title}</Text>
        {props.approval.tier ? (
          <Text className="rounded-lg bg-neutral-200 px-2 py-1 font-t3-bold text-2xs uppercase text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {props.approval.tier}
          </Text>
        ) : null}
        {props.approval.approvalMode ? (
          <Text className="rounded-lg bg-neutral-200 px-2 py-1 font-t3-bold text-2xs uppercase text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {props.approval.approvalMode}
          </Text>
        ) : null}
      </View>
      {props.approval.reason ? (
        <Text className="font-sans text-sm leading-normal text-neutral-600 dark:text-neutral-400">
          {props.approval.reason}
        </Text>
      ) : null}
      {argumentsText ? (
        <View className="rounded-2xl border border-neutral-200 bg-white p-3 dark:border-white/8 dark:bg-neutral-950/70">
          <Text className="font-t3-bold text-2xs uppercase text-neutral-500">Arguments</Text>
          <Text className="mt-1 font-mono text-xs leading-normal text-neutral-800 dark:text-neutral-200">
            {argumentsText}
          </Text>
        </View>
      ) : null}
      {props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-neutral-600 dark:text-neutral-400">
          {props.approval.detail}
        </Text>
      ) : null}
      {props.approval.details?.map((detail) => (
        <Text key={detail} className="font-sans text-xs text-neutral-600 dark:text-neutral-400">
          • {detail}
        </Text>
      ))}
      {props.approval.providerSafetyChecks?.length ? (
        <View className="rounded-2xl border border-amber-300/50 bg-amber-50 p-3 dark:border-amber-400/20 dark:bg-amber-400/10">
          <Text className="font-t3-bold text-xs text-amber-800 dark:text-amber-200">
            Provider safety checks
          </Text>
          {props.approval.providerSafetyChecks.map((check) => (
            <Text key={check} className="mt-1 font-sans text-xs text-amber-800 dark:text-amber-200">
              • {check}
            </Text>
          ))}
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {options.map((option) => (
          <Pressable
            key={option.decision}
            className={`items-center justify-center rounded-[14px] px-3.5 py-3 ${
              option.decision === "accept"
                ? "bg-blue-500"
                : option.decision === "decline"
                  ? "bg-rose-100 dark:bg-rose-500/18"
                  : "bg-neutral-200 dark:bg-neutral-800"
            }`}
            disabled={props.respondingApprovalId === props.approval.requestId}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
          >
            <Text
              className={`text-sm ${
                option.decision === "accept"
                  ? "font-t3-extrabold text-white"
                  : option.decision === "decline"
                    ? "font-t3-bold text-rose-700 dark:text-rose-300"
                    : "font-t3-bold text-neutral-950 dark:text-neutral-50"
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

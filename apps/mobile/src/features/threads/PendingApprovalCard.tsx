import type { ApprovalRequestId, ProviderApprovalDecision } from "@t3tools/contracts";
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

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const allowed = props.approval.allowedDecisions ?? [
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
  ];
  const argumentsText =
    props.approval.args === undefined ? null : JSON.stringify(props.approval.args, null, 2);
  const title = props.approval.toolName ?? props.approval.requestKind;

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
        {allowed.includes("accept") ? (
          <Pressable
            className="items-center justify-center rounded-[14px] bg-blue-500 px-3.5 py-3"
            disabled={props.respondingApprovalId === props.approval.requestId}
            onPress={() => void props.onRespond(props.approval.requestId, "accept")}
          >
            <Text className="font-t3-extrabold text-sm text-white">Allow once</Text>
          </Pressable>
        ) : null}
        {allowed.includes("acceptForSession") ? (
          <Pressable
            className="items-center justify-center rounded-[14px] bg-neutral-200 px-3.5 py-3 dark:bg-neutral-800"
            disabled={props.respondingApprovalId === props.approval.requestId}
            onPress={() => void props.onRespond(props.approval.requestId, "acceptForSession")}
          >
            <Text className="font-t3-bold text-sm text-neutral-950 dark:text-neutral-50">
              Allow session
            </Text>
          </Pressable>
        ) : null}
        {allowed.includes("decline") ? (
          <Pressable
            className="items-center justify-center rounded-[14px] bg-rose-100 px-3.5 py-3 dark:bg-rose-500/18"
            disabled={props.respondingApprovalId === props.approval.requestId}
            onPress={() => void props.onRespond(props.approval.requestId, "decline")}
          >
            <Text className="font-t3-bold text-sm text-rose-700 dark:text-rose-300">Decline</Text>
          </Pressable>
        ) : null}
        {allowed.includes("cancel") ? (
          <Pressable
            className="items-center justify-center rounded-[14px] px-3.5 py-3"
            disabled={props.respondingApprovalId === props.approval.requestId}
            onPress={() => void props.onRespond(props.approval.requestId, "cancel")}
          >
            <Text className="font-t3-bold text-sm text-neutral-600 dark:text-neutral-300">
              Cancel turn
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

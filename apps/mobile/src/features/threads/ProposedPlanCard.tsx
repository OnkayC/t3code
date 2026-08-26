import {
  TurnId,
  type ProviderPlanExecutionModel,
  type ProviderPlanReviewContextStrategy,
  type ProviderPlanReviewDecision,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { PendingPlanReview } from "../../lib/threadActivity";
import { uuidv4 } from "../../lib/uuid";

const CONTEXT_LABELS: Record<ProviderPlanReviewContextStrategy, string> = {
  fresh: "Fresh context",
  preserve: "Preserve context",
  compact: "Compact first",
};

function executionModelKey(model: ProviderPlanExecutionModel): string {
  return `${model.provider}:${model.modelId}:${model.thinkingLevel ?? ""}`;
}

export function ProposedPlanCard(props: {
  readonly review: PendingPlanReview;
  readonly responding: boolean;
  readonly onRespond: (decision: ProviderPlanReviewDecision) => Promise<unknown>;
}) {
  const [context, setContext] = useState<ProviderPlanReviewContextStrategy>(
    props.review.allowedContextStrategies[0] ?? "fresh",
  );
  const [selectedModelKey, setSelectedModelKey] = useState(() => {
    const model = props.review.defaultExecutionModel ?? props.review.executionModels[0];
    return model ? executionModelKey(model) : "";
  });
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    setContext(props.review.allowedContextStrategies[0] ?? "fresh");
    const model = props.review.defaultExecutionModel ?? props.review.executionModels[0];
    setSelectedModelKey(model ? executionModelKey(model) : "");
    setFeedback("");
  }, [props.review.requestId]);

  const executionModel = useMemo(
    () =>
      props.review.executionModels.find((model) => executionModelKey(model) === selectedModelKey),
    [props.review.executionModels, selectedModelKey],
  );

  return (
    <View className="gap-3 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <View className="gap-1">
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-emerald-700 dark:text-emerald-300">
          Plan review
        </Text>
        <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
          {props.review.title}
        </Text>
        <Text className="font-mono text-xs text-neutral-500">{props.review.planArtifactId}</Text>
      </View>
      <ScrollView className="max-h-64 rounded-2xl bg-white p-3 dark:bg-neutral-950/70">
        <Text
          selectable
          className="font-sans text-sm leading-relaxed text-neutral-800 dark:text-neutral-200"
        >
          {props.review.planMarkdown}
        </Text>
      </ScrollView>
      <View className="gap-2">
        <Text className="font-t3-bold text-xs uppercase tracking-[0.8px] text-neutral-500">
          Execution context
        </Text>
        <View className="flex-row flex-wrap gap-2">
          {props.review.allowedContextStrategies.map((strategy) => (
            <Pressable
              key={strategy}
              disabled={props.responding}
              className={cn(
                "rounded-full border px-3 py-2",
                context === strategy
                  ? "border-blue-300/50 bg-blue-50 dark:border-blue-400/28 dark:bg-blue-400/14"
                  : "border-neutral-200 bg-white dark:border-white/6 dark:bg-neutral-950/70",
              )}
              onPress={() => setContext(strategy)}
            >
              <Text className="font-t3-bold text-xs text-neutral-700 dark:text-neutral-200">
                {CONTEXT_LABELS[strategy]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {props.review.executionModels.length > 0 ? (
        <View className="gap-2">
          <Text className="font-t3-bold text-xs uppercase tracking-[0.8px] text-neutral-500">
            Execution model
          </Text>
          <View className="gap-2">
            {props.review.executionModels.map((model) => {
              const key = executionModelKey(model);
              return (
                <Pressable
                  key={key}
                  disabled={props.responding}
                  className={cn(
                    "rounded-2xl border px-3 py-2.5",
                    selectedModelKey === key
                      ? "border-blue-300/50 bg-blue-50 dark:border-blue-400/28 dark:bg-blue-400/14"
                      : "border-neutral-200 bg-white dark:border-white/6 dark:bg-neutral-950/70",
                  )}
                  onPress={() => setSelectedModelKey(key)}
                >
                  <Text className="font-t3-bold text-sm text-neutral-800 dark:text-neutral-100">
                    {model.provider} / {model.modelId}
                    {model.thinkingLevel ? ` · ${model.thinkingLevel}` : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
      <View className="flex-row flex-wrap justify-end gap-2">
        <Pressable
          disabled={props.responding}
          className="rounded-2xl border border-neutral-300 px-4 py-3 dark:border-white/10"
          onPress={() => void props.onRespond({ action: "cancel" })}
        >
          <Text className="font-t3-bold text-sm text-neutral-700 dark:text-neutral-200">
            Cancel review
          </Text>
        </Pressable>
        <Pressable
          disabled={props.responding}
          className="rounded-2xl bg-blue-500 px-4 py-3"
          onPress={() =>
            void props.onRespond({
              action: "execute",
              context,
              ...(executionModel ? { executionModel } : {}),
              clientTurnId: TurnId.make(uuidv4()),
            })
          }
        >
          <Text className="font-t3-extrabold text-sm text-white">Execute plan</Text>
        </Pressable>
      </View>
      <View className="gap-2 border-t border-neutral-200 pt-3 dark:border-white/6">
        <TextInput
          value={feedback}
          onChangeText={setFeedback}
          placeholder="What should change before execution?"
          editable={!props.responding}
          multiline
          className="min-h-[76px] rounded-2xl border border-neutral-200 bg-white px-3.5 py-3 font-sans text-sm text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50"
        />
        <Pressable
          disabled={props.responding || feedback.trim().length === 0}
          className={cn(
            "self-end rounded-2xl px-4 py-3",
            feedback.trim().length > 0
              ? "bg-neutral-800 dark:bg-neutral-200"
              : "bg-neutral-200 dark:bg-neutral-700",
          )}
          onPress={() =>
            void props.onRespond({
              action: "refine",
              feedback: feedback.trim(),
              clientTurnId: TurnId.make(uuidv4()),
            })
          }
        >
          <Text className="font-t3-bold text-sm text-white dark:text-neutral-950">
            Request refinement
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

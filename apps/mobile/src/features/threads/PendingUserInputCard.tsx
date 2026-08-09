import type {
  ApprovalRequestId,
  ProviderUserInputAnswer,
  ProviderUserInputResponse,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { PendingUserInput, PendingUserInputDraftAnswer } from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly pendingUserInput: PendingUserInput;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, ProviderUserInputAnswer> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly onSelectOption: (
    requestId: ApprovalRequestId,
    questionId: string,
    label: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onChangeNote: (requestId: ApprovalRequestId, questionId: string, note: string) => void;
  readonly onRespond: (response: ProviderUserInputResponse) => Promise<unknown>;
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const allowedActions = props.pendingUserInput.allowedActions ?? ["submit"];
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;

  return (
    <View className="gap-3 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
          User input needed
        </Text>
        {props.pendingUserInput.timeout !== undefined ? (
          <Text className="font-sans text-xs text-neutral-500">
            {Math.max(1, Math.ceil(props.pendingUserInput.timeout / 1000))}s timeout
          </Text>
        ) : null}
      </View>
      {props.pendingUserInput.questions.map((question, questionIndex) => {
        const draft = props.drafts[question.id];
        return (
          <View
            key={question.id}
            className="gap-2 border-t border-neutral-200 pt-3 first:border-t-0 first:pt-0 dark:border-white/6"
          >
            {question.header ? (
              <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500">
                {question.header}
              </Text>
            ) : props.pendingUserInput.questions.length > 1 ? (
              <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500">
                Question {questionIndex + 1}
              </Text>
            ) : null}
            <Text className="font-sans text-base leading-snug text-neutral-950 dark:text-neutral-50">
              {question.question}
            </Text>
            {question.multiSelect ? (
              <Text className="font-sans text-xs text-neutral-500">Select one or more.</Text>
            ) : null}
            <View className="gap-2">
              {question.options.map((option, optionIndex) => {
                const selected =
                  draft?.selectedOptionLabels?.includes(option.label) === true &&
                  !draft.customAnswer?.trim().length;
                const recommended = question.recommended === optionIndex;
                return (
                  <Pressable
                    key={option.label}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled: isResponding }}
                    disabled={isResponding}
                    className={cn(
                      "rounded-2xl border px-3 py-2.5",
                      selected
                        ? "border-blue-300/50 bg-blue-50 dark:border-blue-400/28 dark:bg-blue-400/14"
                        : "border-neutral-200 bg-white dark:border-white/6 dark:bg-neutral-950/70",
                    )}
                    onPress={() =>
                      props.onSelectOption(
                        props.pendingUserInput.requestId,
                        question.id,
                        option.label,
                      )
                    }
                  >
                    <View className="flex-row items-center justify-between gap-3">
                      <Text
                        className={cn(
                          "font-t3-bold text-sm",
                          selected
                            ? "text-sky-700 dark:text-sky-300"
                            : "text-neutral-700 dark:text-neutral-200",
                        )}
                      >
                        {option.label}
                      </Text>
                      {recommended ? (
                        <Text className="font-t3-bold text-2xs uppercase tracking-[0.8px] text-emerald-700 dark:text-emerald-300">
                          Recommended
                        </Text>
                      ) : null}
                    </View>
                    {option.description ? (
                      <Text className="mt-1 font-sans text-xs leading-snug text-neutral-500">
                        {option.description}
                      </Text>
                    ) : null}
                    {option.preview ? (
                      <View className="mt-2 rounded-xl bg-neutral-100 px-2.5 py-2 dark:bg-neutral-800">
                        <Text className="font-mono text-xs leading-snug text-neutral-600 dark:text-neutral-300">
                          {option.preview}
                        </Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            {question.allowCustom !== false ? (
              <TextInput
                value={draft?.customAnswer ?? ""}
                onChangeText={(value) =>
                  props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
                }
                placeholder="Custom answer"
                editable={!isResponding}
                className="min-h-[52px] rounded-2xl border border-neutral-200 bg-white px-3.5 py-3 font-sans text-base text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50"
              />
            ) : null}
            {props.pendingUserInput.supportsNote ? (
              <TextInput
                value={draft?.note ?? ""}
                onChangeText={(value) =>
                  props.onChangeNote(props.pendingUserInput.requestId, question.id, value)
                }
                placeholder="Optional note"
                editable={!isResponding}
                className="min-h-[44px] rounded-2xl border border-neutral-200 bg-white px-3.5 py-2.5 font-sans text-sm text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50"
              />
            ) : null}
          </View>
        );
      })}
      <View className="flex-row flex-wrap justify-end gap-2">
        {allowedActions.includes("cancel") ? (
          <Pressable
            disabled={isResponding}
            className="rounded-2xl border border-neutral-300 px-4 py-3 dark:border-white/10"
            onPress={() => void props.onRespond({ kind: "cancel" })}
          >
            <Text className="font-t3-bold text-sm text-neutral-700 dark:text-neutral-200">
              Cancel
            </Text>
          </Pressable>
        ) : null}
        {allowedActions.includes("chat") ? (
          <Pressable
            disabled={isResponding}
            className="rounded-2xl border border-neutral-300 px-4 py-3 dark:border-white/10"
            onPress={() => void props.onRespond({ kind: "chat" })}
          >
            <Text className="font-t3-bold text-sm text-neutral-700 dark:text-neutral-200">
              Answer in chat
            </Text>
          </Pressable>
        ) : null}
        {allowedActions.includes("submit") ? (
          <Pressable
            className={cn(
              "items-center justify-center rounded-2xl px-4 py-3",
              props.answers ? "bg-blue-500" : "bg-neutral-200 dark:bg-neutral-700/60",
            )}
            disabled={props.answers === null || isResponding}
            onPress={() =>
              props.answers
                ? void props.onRespond({ kind: "submit", answers: props.answers })
                : undefined
            }
          >
            <Text className="font-t3-extrabold text-sm text-white">Submit answers</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

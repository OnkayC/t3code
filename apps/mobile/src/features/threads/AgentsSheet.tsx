import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  type AgentPanelModel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { Linking, Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

function AgentRow({ agent }: { readonly agent: RuntimeSubagent }) {
  const handles = agent.runHandles;
  return (
    <View className="gap-1.5 border-t border-neutral-200 py-3 first:border-t-0 dark:border-white/6">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          <Text className="font-t3-bold text-sm text-neutral-950 dark:text-neutral-50">
            {agent.title}
          </Text>
          <Text className="font-sans text-xs text-neutral-500">
            {[agent.role, formatSubagentModelLabel(agent.model, agent.effort)]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        <Text className="font-t3-bold text-2xs uppercase tracking-[0.7px] text-neutral-500">
          {agent.status}
        </Text>
      </View>
      {agent.progress ? (
        <Text className="font-sans text-sm leading-snug text-neutral-700 dark:text-neutral-300">
          {agent.progress}
        </Text>
      ) : null}
      {agent.error ? (
        <Text className="font-sans text-sm leading-snug text-red-700 dark:text-red-300">
          {agent.error}
        </Text>
      ) : agent.result ? (
        <Text className="font-sans text-sm leading-snug text-neutral-600 dark:text-neutral-400">
          {agent.result}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-x-3 gap-y-1">
        {agent.usage ? (
          <Text className="font-mono text-xs text-neutral-500">
            {formatSubagentTokenCount(agent.usage.totalTokens)} tokens
          </Text>
        ) : null}
        {agent.lastToolName ? (
          <Text className="font-mono text-xs text-neutral-500">Tool: {agent.lastToolName}</Text>
        ) : null}
        {agent.attempt !== null ? (
          <Text className="font-mono text-xs text-neutral-500">Attempt {agent.attempt}</Text>
        ) : null}
      </View>
      {handles?.scriptPath ? (
        <Text selectable className="font-mono text-xs text-neutral-500">
          Script: {handles.scriptPath}
        </Text>
      ) : null}
      {handles?.transcriptDir ? (
        <Text selectable className="font-mono text-xs text-neutral-500">
          Transcript: {handles.transcriptDir}
        </Text>
      ) : null}
      {handles?.sessionUrl ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => void Linking.openURL(handles.sessionUrl!)}
        >
          <Text className="font-t3-bold text-sm text-blue-600 dark:text-blue-300">
            Open agent session
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function AgentsSheet(props: {
  readonly visible: boolean;
  readonly model: AgentPanelModel;
  readonly onClose: () => void;
}) {
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-screen">
        <View className="flex-row items-center justify-between border-b border-neutral-200 px-5 py-4 dark:border-white/6">
          <View>
            <Text className="font-t3-bold text-xl text-neutral-950 dark:text-neutral-50">
              Agents
            </Text>
            <Text className="font-sans text-xs text-neutral-500">
              {props.model.liveCount} active · {props.model.settledCount} settled ·{" "}
              {formatSubagentTokenCount(props.model.totalTokens)} tokens
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            className="rounded-full border border-neutral-200 px-3 py-2 dark:border-white/10"
          >
            <Text className="font-t3-bold text-sm text-neutral-700 dark:text-neutral-200">
              Done
            </Text>
          </Pressable>
        </View>
        <ScrollView contentContainerClassName="gap-5 px-5 py-4 pb-10">
          {props.model.workflows.map((group) => (
            <View
              key={group.workflow.id}
              className="rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900"
            >
              <AgentRow agent={group.workflow} />
              {group.phases.map((phase) => (
                <View key={`${group.workflow.id}:${phase.index}`} className="mt-3">
                  <View className="flex-row items-center justify-between gap-3">
                    <Text className="font-t3-bold text-xs uppercase tracking-[0.8px] text-neutral-500">
                      {phase.title}
                    </Text>
                    <Text className="font-sans text-xs text-neutral-500">
                      {phase.settledCount}/{phase.members.length} settled
                    </Text>
                  </View>
                  {phase.members.map((agent) => (
                    <AgentRow key={agent.id} agent={agent} />
                  ))}
                </View>
              ))}
              {group.unphasedMembers.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </View>
          ))}
          {props.model.directAgents.length > 0 ? (
            <View className="rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
              <Text className="font-t3-bold text-xs uppercase tracking-[0.8px] text-neutral-500">
                Direct agents
              </Text>
              {props.model.directAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

<script setup lang="ts">
import type { AgentMessage } from "~/types/app";
import AgentIcon from "./AgentIcon.vue";
import { activityPreview, agentStatusLabel, formatActivityDuration, formatActivityPayload } from "~/utils/agentTimeline";
import { renderAgentMarkdown } from "~/utils/agentMarkdown";
import { copyAgentText } from "~/utils/agentClipboard";

const props = defineProps<{ message: AgentMessage; now: number; expandAll: boolean | null }>();
const activity = computed(() => props.message.activity!);
const userExpanded = ref<boolean | null>(props.expandAll);
const running = computed(() => ["running", "waiting_confirmation"].includes(activity.value.status));
const expanded = computed(() => userExpanded.value ?? (activity.value.status === "failed" || (activity.value.kind === "reasoning" && running.value)));
const body = ref<HTMLElement | null>(null);
const bodyScroll = useFollowScroll(() => body.value);
const copied = ref("");
const copyError = ref("");
let copyTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.expandAll, (value) => { userExpanded.value = value; });
watch(() => props.message.content, () => {
  if (activity.value.kind !== "reasoning" || !running.value) return;
  bodyScroll.scrollToBottom();
});
async function copy(section: string, content: string) {
  try {
    await copyAgentText(content);
    copied.value = section;
    copyError.value = "";
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = ""; }, 1600);
  } catch { copyError.value = "复制失败，请手动选择内容复制。"; }
}
onBeforeUnmount(() => clearTimeout(copyTimer));
</script>

<template>
  <div class="agent-activity" :class="[activity.kind, activity.status, { expanded }]">
    <button class="agent-activity-trigger" type="button" :aria-expanded="expanded" :aria-controls="`activity-${message.id}`" @click="userExpanded = !expanded">
      <span class="agent-activity-node" :class="{ spinning: running && activity.status !== 'waiting_confirmation' }">
        <AgentIcon :name="activity.status === 'failed' ? 'error' : activity.kind === 'reasoning' ? 'brain' : activity.kind === 'retry' ? 'retry' : 'tool'" />
      </span>
      <span class="agent-activity-heading">{{ activity.kind === 'reasoning' ? '思考过程' : activity.title }}</span>
      <span v-if="!expanded" class="agent-activity-preview">{{ activityPreview(message) }}</span>
      <span class="agent-activity-state">{{ agentStatusLabel(activity.status) }}</span>
      <span class="agent-activity-duration">{{ activity.finishedAt || running ? formatActivityDuration(activity.startedAt, activity.finishedAt, now) : '—' }}</span>
      <AgentIcon name="chevron" class="agent-disclosure-chevron" />
    </button>
    <div v-if="expanded" :id="`activity-${message.id}`" class="agent-activity-body">
      <div v-if="activity.error" class="agent-inline-error" :class="{ warning: activity.kind === 'retry' }">
        <strong>{{ activity.kind === 'retry' ? '上游错误' : activity.status === 'cancelled' ? '中断原因' : '错误原因' }}</strong>
        <p>{{ activity.error }}</p>
      </div>
      <div v-if="activity.kind === 'tool' && activity.input !== undefined" class="agent-payload">
        <div class="agent-payload-header"><span>输入参数</span><button type="button" class="agent-text-button" @click="copy('input', activity.input!)"><AgentIcon :name="copied === 'input' ? 'check' : 'copy'" />{{ copied === 'input' ? '已复制' : '复制' }}</button></div>
        <pre>{{ formatActivityPayload(activity.input) }}</pre>
      </div>
      <div v-if="message.content" class="agent-payload" :class="{ 'agent-reasoning-body': activity.kind === 'reasoning' }">
        <div class="agent-payload-header"><span>{{ activity.kind === 'reasoning' ? '模型返回的思考内容' : activity.kind === 'retry' ? '重试结果' : '输出结果' }}</span><button type="button" class="agent-text-button" @click="copy('output', message.content)"><AgentIcon :name="copied === 'output' ? 'check' : 'copy'" />{{ copied === 'output' ? '已复制' : '复制' }}</button></div>
        <div v-if="activity.kind === 'reasoning'" ref="body" class="agent-reasoning-scroll markdown-content" tabindex="0" @scroll="bodyScroll.onScroll" @wheel.passive="bodyScroll.onWheel" @touchstart.passive="bodyScroll.onTouchstart" @touchmove.passive="bodyScroll.onTouchmove" @keydown="bodyScroll.onKeydown" v-html="renderAgentMarkdown(message.content)" />
        <pre v-else>{{ formatActivityPayload(message.content) }}</pre>
      </div>
      <p v-else-if="running" class="agent-activity-waiting">{{ activity.status === 'waiting_confirmation' ? '请确认操作，Agent 将在确认后继续。' : activity.kind === 'retry' ? '等待下一次模型请求…' : '正在等待结果…' }}</p>
      <p v-if="copyError" class="agent-copy-error" role="status">{{ copyError }}</p>
    </div>
  </div>
</template>

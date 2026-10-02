<script setup lang="ts">
import type { AgentContextUsage, AgentMessage, AgentRetryState, AgentStatus } from "~/types/app";
import type { PendingAgentAttachment, UploadState } from "~/types/ui";
import type { IconName } from "~/utils/icons";
import AgentIcon from "~/components/agent/AgentIcon.vue";
import AgentActivityRow from "~/components/agent/AgentActivityRow.vue";
import { renderAgentMarkdown } from "~/utils/agentMarkdown";
import { agentStatusLabel, buildAgentTurns, type AgentTurn } from "~/utils/agentTimeline";
import { copyAgentText } from "~/utils/agentClipboard";

const props = defineProps<{
  attachments: PendingAgentAttachment[];
  autoConfirm: boolean;
  busy: boolean;
  contextRemainingLabel: string;
  contextRingStyle: Record<string, string>;
  contextUsage: AgentContextUsage;
  input: string;
  messages: AgentMessage[];
  historyLoading: boolean;
  historyError: string;
  configLoading: boolean;
  configError?: string;
  contextLoading: boolean;
  contextError?: string;
  modelName?: string;
  /** Models the user can switch this conversation to (from the saved config). */
  modelOptions?: string[];
  outputLoading: boolean;
  outputLoadingText: string;
  placeholder: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high";
  retry: AgentRetryState | null;
  retryMessage: string;
  retryNowSending: boolean;
  scrollToBottomVisible: boolean;
  status: AgentStatus;
  upload: UploadState;
  uploadDetail: (upload: UploadState) => string;
  /** Upload session bound to this panel's conversation (instance id or "global"). */
  uploadSessionId: string;
  /** Small line under the header title (global dashboard). */
  panelSubtitle?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Global dashboard conversation: per-turn handoff chips route to an instance. */
  focusServerIdFor?: (message: AgentMessage) => string | null;
  /** Resolves a display name for a handoff target (global dashboard only). */
  focusLabelFor?: (serverId: string) => string;
  /** Shortcut prompts shown above the composer (global dashboard only). */
  quickPrompts?: Array<{ icon: IconName; label: string; text: string }>;
}>();

const emit = defineEmits<{
  cancel: [];
  "reload-history": [];
  clear: [];
  compress: [];
  "remove-attachment": [path: string];
  retry: [];
  send: [];
  "reuse-message": [content: string];
  "message-scroll": [];
  "scroll-to-bottom": [];
  "update:auto-confirm": [value: boolean];
  "update:input": [value: string];
  "update:model-name": [value: string];
  "update:reasoning-effort": [value: "minimal" | "low" | "medium" | "high"];
  upload: [event: Event];
  "upload-requested": [];
  /** Global dashboard: user clicked a handoff chip to open that instance. */
  "open-instance": [serverId: string];
}>();

const panel = ref<HTMLElement | null>(null);
const messageList = ref<HTMLElement | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);
const inputField = ref<HTMLTextAreaElement | null>(null);
const showReasoning = ref(true);
const expandAll = ref<boolean | null>(null);
const now = ref(Date.now());
const copied = ref("");
const copyError = ref("");
let clock: ReturnType<typeof setInterval> | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;
const turns = computed(() => buildAgentTurns(props.messages, props.busy));
const lastUser = computed(() => props.messages.filter((message) => message.role === "user").at(-1));
const hasActivities = computed(() => turns.value.some((turn) => turn.messages.some((message) => message.activity)));
const activeActivity = computed(() => props.messages.findLast((message) => message.activity && ["running", "waiting_confirmation"].includes(message.activity.status))?.activity);
const panelTitle = "Agent";
const progressLabel = computed(() => {
  if (props.status === "waiting_confirmation") return "等待你确认操作";
  if (props.retry) return props.retryMessage;
  if (activeActivity.value?.kind === "reasoning") return "正在思考";
  if (activeActivity.value?.kind === "tool") return `正在执行 ${activeActivity.value.toolName}`;
  return props.outputLoading ? props.outputLoadingText : "正在生成回复";
});

function focusPanel() {
  panel.value?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  panel.value?.focus({ preventScroll: true });
}
function focusInput() { inputField.value?.focus(); }
function getMessageList() { return messageList.value; }
function openUploadPicker() { uploadInput.value?.click(); }
function formatMessageTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function toolCount(turn: AgentTurn) { return turn.messages.filter((message) => message.activity?.kind === "tool").length; }
/** Global dashboard only: the instance this turn handed off to, if any. */
function focusTargetFor(turn: AgentTurn) {
  if (!props.focusServerIdFor) return null;
  for (const message of turn.messages) {
    const serverId = props.focusServerIdFor(message);
    if (serverId) return { serverId };
  }
  return null;
}
function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!props.busy && !props.historyLoading && !props.configLoading && !props.configError) emit("send");
  }
}
function resizeInput() {
  if (!inputField.value) return;
  inputField.value.style.height = "auto";
  inputField.value.style.height = `${Math.min(inputField.value.scrollHeight, 180)}px`;
}
function reuseLastMessage() {
  if (!lastUser.value) return;
  emit("reuse-message", lastUser.value.content);
  void nextTick(focusInput);
}
/** Quick prompts fill the composer and send immediately. */
function useQuickPrompt(text: string) {
  if (props.busy || props.historyLoading || props.configLoading || props.configError) return;
  emit("update:input", text);
  void nextTick(() => emit("send"));
}
async function copyTurn(turn: AgentTurn) {
  try {
    await copyAgentText(turn.messages.filter((message) => !message.activity && message.role !== "system").map((message) => message.content).join("\n\n"));
    copied.value = turn.id;
    copyError.value = "";
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = ""; }, 1600);
  } catch { copyError.value = "复制失败，请手动选择内容复制。"; }
}
watch(() => props.input, () => { void nextTick(resizeInput); });
watch(showReasoning, (value) => { try { localStorage.setItem("agent-show-reasoning", String(value)); } catch { /* Storage is optional. */ } });
watch(() => props.busy, (busy) => {
  clearInterval(clock);
  now.value = Date.now();
  if (busy) clock = setInterval(() => { now.value = Date.now(); }, 1000);
});
onMounted(() => {
  try { showReasoning.value = localStorage.getItem("agent-show-reasoning") !== "false"; } catch { /* Use the default. */ }
  if (props.busy) clock = setInterval(() => { now.value = Date.now(); }, 1000);
  resizeInput();
});
onBeforeUnmount(() => { clearInterval(clock); clearTimeout(copyTimer); });
defineExpose({ focusPanel, focusInput, getMessageList, openUploadPicker });
</script>

<template>
  <section ref="panel" tabindex="-1" class="card stack agent-card workspace-card single-agent-panel" aria-label="Agent 对话">
    <header class="agent-panel-header">
      <div class="agent-panel-title"><AgentIcon name="spark" /><div class="agent-panel-heading"><h2>{{ panelTitle }}</h2><p v-if="props.panelSubtitle" class="agent-panel-subtitle">{{ props.panelSubtitle }}</p></div><span class="agent-session-status" :class="props.status"><i :class="{ 'agent-pulse': props.busy || props.historyLoading }" />{{ props.historyLoading ? '加载中' : agentStatusLabel(props.status) }}</span></div>
      <div class="agent-header-actions">
        <button class="agent-icon-button" type="button" :aria-pressed="showReasoning" :title="showReasoning ? '隐藏思考内容' : '显示思考内容'" :aria-label="showReasoning ? '隐藏思考内容' : '显示思考内容'" @click="showReasoning = !showReasoning"><AgentIcon name="brain" /></button>
        <button class="agent-icon-button" type="button" :disabled="!hasActivities" :title="expandAll ? '收起执行详情' : '展开执行详情'" :aria-label="expandAll ? '收起执行详情' : '展开执行详情'" @click="expandAll = !expandAll"><AgentIcon :name="expandAll ? 'collapse' : 'expand'" /></button>
        <span class="agent-header-divider" />
        <span v-if="props.contextLoading" class="context-ring async-skeleton" role="status" aria-label="正在加载上下文用量" />
        <span v-else-if="props.contextError" class="context-ring" role="img" aria-label="上下文用量暂不可用" title="上下文用量暂不可用">—</span>
        <div v-else class="context-ring" :style="props.contextRingStyle" role="img" :aria-label="props.contextRemainingLabel" tabindex="0">
          <span class="context-ring-core"><strong>{{ Math.round(props.contextUsage.remainingRatio * 100) }}</strong><small>%</small></span>
          <div class="context-ring-tooltip" role="tooltip"><strong>上下文用量</strong><span>剩余 {{ Math.round(props.contextUsage.remainingRatio * 100) }}%</span><span>已用 {{ props.contextUsage.usedTokens.toLocaleString() }} tokens</span><span>剩余 {{ props.contextUsage.remainingTokens.toLocaleString() }} tokens</span><span>上限 {{ props.contextUsage.maxTokens.toLocaleString() }} tokens</span></div>
        </div>
        <button class="agent-icon-button" type="button" title="压缩上下文" aria-label="压缩上下文" :disabled="props.busy || !props.messages.length" @click="emit('compress')"><AgentIcon name="compress" /></button>
        <button class="agent-icon-button" type="button" title="清除上下文" aria-label="清除上下文" :disabled="props.busy || !props.messages.length" @click="emit('clear')"><AgentIcon name="trash" /></button>
      </div>
    </header>

    <div class="agent-message-shell">
      <div ref="messageList" class="message-list" aria-label="对话消息与执行记录" :aria-busy="props.historyLoading" @scroll="emit('message-scroll')">
        <AsyncPlaceholder v-if="props.historyLoading" variant="conversation" label="正在加载对话记录" />
        <AsyncPlaceholder v-else-if="props.historyError" variant="compact" :error="props.historyError" @retry="emit('reload-history')" />
        <div v-else-if="!turns.length" class="agent-empty-state">
          <span class="agent-empty-mark"><AgentIcon name="spark" /></span>
          <h3>{{ props.emptyTitle ?? '一起管理你的服务器' }}</h3><p>{{ props.emptyDescription ?? '描述任务，实时查看思考、工具调用和执行结果。' }}</p>
          <div v-if="!props.quickPrompts?.length" class="agent-suggestions"><button type="button" @click="emit('update:input', '检查当前服务器的配置和运行状态'); focusInput()"><AgentIcon name="tool" />检查服务器状态</button><button type="button" @click="emit('update:input', '帮我分析最近的服务端错误日志'); focusInput()"><AgentIcon name="file" />分析错误日志</button></div>
        </div>
        <div class="agent-turn-stream">
          <article v-for="turn in turns" :key="turn.id" class="agent-turn" :class="turn.role">
            <template v-if="turn.role === 'user'">
              <div class="agent-user-message">{{ turn.messages[0]?.content }}</div>
              <div class="agent-turn-footer"><time :datetime="turn.createdAt">{{ formatMessageTime(turn.createdAt) }}</time><button class="agent-icon-button" type="button" :aria-label="copied === turn.id ? '已复制消息' : '复制消息'" @click="copyTurn(turn)"><AgentIcon :name="copied === turn.id ? 'check' : 'copy'" /></button></div>
            </template>
            <template v-else>
              <div class="agent-turn-heading"><AgentIcon name="spark" /><strong>Agent</strong><time :datetime="turn.createdAt">{{ formatMessageTime(turn.createdAt) }}</time></div>
              <div class="agent-turn-content">
                <template v-for="message in turn.messages" :key="message.id">
                  <AgentActivityRow v-if="message.activity && (message.activity.kind !== 'reasoning' || showReasoning)" :message="message" :now="now" :expand-all="expandAll" />
                  <div v-else-if="!message.activity && message.status === 'failed'" class="agent-error-card" role="alert"><div class="agent-error-title"><AgentIcon name="error" /><strong>执行失败</strong></div><p>{{ message.content.replace(/^执行失败[：:]\s*/, '') }}</p><button v-if="turn.id === turns.at(-1)?.id && !props.busy && lastUser" class="agent-text-button" type="button" @click="reuseLastMessage"><AgentIcon name="retry" />编辑并重试</button></div>
                  <div v-else-if="!message.activity && message.status === 'cancelled'" class="agent-cancelled-notice"><AgentIcon name="stop" />{{ message.content }}</div>
                  <div v-else-if="!message.activity && message.role === 'agent'" class="agent-response markdown-content" v-html="renderAgentMarkdown(message.content)" />
                  <details v-else-if="!message.activity" class="agent-system-notice"><summary>{{ message.content.split('\n')[0] }}</summary><pre>{{ message.content }}</pre></details>
                </template>
                <button
                  v-if="props.focusServerIdFor && focusTargetFor(turn)"
                  class="agent-focus-chip"
                  type="button"
                  @click="emit('open-instance', focusTargetFor(turn)!.serverId)"
                >
                  <AgentIcon name="terminal" />
                  已跳转到「{{ props.focusLabelFor ? props.focusLabelFor(focusTargetFor(turn)!.serverId) : focusTargetFor(turn)!.serverId }}」 · 查看终端
                  <AgentIcon name="chevronRight" />
                </button>
              </div>
              <div v-if="turn.id !== turns.at(-1)?.id || !props.busy" class="agent-turn-footer">
                <span v-if="toolCount(turn)">{{ toolCount(turn) }} 次工具调用</span>
                <span v-if="turn.messages.some(m => m.activity?.status === 'failed')" class="agent-failure-count">{{ turn.messages.filter(m => m.activity?.status === 'failed').length }} 次失败</span>
                <button v-if="turn.messages.some(m => m.role === 'agent' && m.content)" class="agent-icon-button" type="button" :aria-label="copied === turn.id ? '已复制回复' : '复制回复'" @click="copyTurn(turn)"><AgentIcon :name="copied === turn.id ? 'check' : 'copy'" /></button>
              </div>
            </template>
          </article>
          <div v-if="props.busy" class="agent-live-status" role="status"><span class="agent-busy-dots" aria-hidden="true"><i /><i /><i /></span><span>{{ progressLabel }}</span></div>
        </div>
      </div>
      <Transition name="agent-scroll-bottom"><button v-if="props.scrollToBottomVisible" class="agent-scroll-bottom" type="button" @click="emit('scroll-to-bottom')"><AgentIcon name="down" />回到最新</button></Transition>
    </div>

    <div class="agent-composer">
      <div v-if="props.quickPrompts?.length" class="agent-quick-row">
        <button v-for="prompt in props.quickPrompts" :key="prompt.label" class="agent-quick-chip" type="button" :disabled="props.busy || props.historyLoading || props.configLoading || Boolean(props.configError)" @click="useQuickPrompt(prompt.text)">
          <AgentIcon :name="prompt.icon" />
          {{ prompt.label }}
        </button>
      </div>
      <div v-if="props.retry" class="agent-retry-banner" role="status"><AgentIcon name="retry" /><div><strong>{{ props.retryMessage }}</strong><p>{{ props.retry.message }}</p></div><button class="agent-text-button" type="button" :disabled="props.retryNowSending" @click="emit('retry')">{{ props.retryNowSending ? '重试中' : '立即重试' }}</button></div>
      <p v-if="copyError" class="agent-copy-error" role="status">{{ copyError }}</p>
      <div class="agent-composer-shell">
        <div v-if="props.attachments.length" class="agent-attachment-list"><div v-for="attachment in props.attachments" :key="attachment.uploadId" class="agent-file-chip" :title="attachment.uploadId"><AgentIcon name="file" /><span>{{ attachment.originalName }}</span><button class="agent-icon-button" type="button" :aria-label="`移除 ${attachment.originalName}`" :disabled="props.busy" @click="emit('remove-attachment', attachment.uploadId)"><AgentIcon name="close" /></button></div></div>
        <div v-if="props.upload.active" class="agent-upload-status" role="status"><span>{{ props.upload.done ? '上传完成' : '正在上传' }} {{ props.upload.fileName }} · {{ props.upload.percent }}%</span><div class="progress-track"><span :style="{ width: `${props.upload.percent}%` }" /></div><small>{{ props.uploadDetail(props.upload) }}</small></div>
        <textarea ref="inputField" :value="props.input" :placeholder="props.busy ? '可以先草拟下一条消息…' : props.placeholder" aria-label="发送给 Agent 的消息" rows="2" @input="emit('update:input', ($event.target as HTMLTextAreaElement).value)" @keydown="onKeydown" />
        <div class="agent-composer-footer">
          <div class="agent-composer-tools">
            <button class="agent-icon-button" type="button" :disabled="props.upload.active || props.busy" title="上传文件" aria-label="上传文件" @click="emit('upload-requested')"><AgentIcon name="attach" /></button>
            <span v-if="props.configLoading" class="agent-model-label" role="status"><AppIcon name="loader" :spin="true" :size="13" />加载模型…</span>
            <span v-else-if="props.configError" class="agent-model-label" role="status">模型配置未就绪</span>
            <label v-else-if="props.modelOptions && props.modelOptions.length > 1" class="agent-model-select" title="选择本次对话使用的模型"><AgentIcon name="spark" /><select :value="props.modelName || ''" :disabled="props.busy" aria-label="选择模型" @change="emit('update:model-name', ($event.target as HTMLSelectElement).value)"><option v-if="!props.modelName" value="" disabled>选择模型…</option><option v-for="model in props.modelOptions" :key="model" :value="model">{{ model }}</option></select></label>
            <span v-else class="agent-model-label" :title="props.modelName || '本地引导模式'"><AgentIcon name="spark" />{{ props.modelName || '本地引导' }}</span>
            <label class="agent-effort-select"><AgentIcon name="brain" /><select :value="props.reasoningEffort" :disabled="props.busy" title="思考深度" aria-label="思考深度" @change="emit('update:reasoning-effort', ($event.target as HTMLSelectElement).value as 'minimal' | 'low' | 'medium' | 'high')"><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          </div>
          <div class="agent-composer-actions"><button v-if="props.busy" class="agent-stop-button" type="button" aria-label="中断任务" title="中断任务" @click="emit('cancel')"><AgentIcon name="stop" /></button><button v-else class="agent-send-button" type="button" aria-label="发送任务" title="发送任务 (Enter)" :disabled="props.historyLoading || props.configLoading || Boolean(props.configError) || (!props.input.trim() && !props.attachments.length)" @click="emit('send')"><AgentIcon name="send" /></button></div>
        </div>
      </div>
      <div class="agent-composer-hint"><span v-if="props.configLoading" class="muted">正在加载 Agent 配置…</span><span v-else-if="props.configError" role="status">配置加载失败，请在设置中重试</span><label v-else class="agent-auto-confirm"><input :checked="props.autoConfirm" type="checkbox" @change="emit('update:auto-confirm', ($event.target as HTMLInputElement).checked)" /><span>自动确认操作</span></label><span>Enter 发送 · Shift + Enter 换行</span></div>
      <input ref="uploadInput" class="visually-hidden" type="file" tabindex="-1" @change="emit('upload', $event)" />
    </div>
  </section>
</template>

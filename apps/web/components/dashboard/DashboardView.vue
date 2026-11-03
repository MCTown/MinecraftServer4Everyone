<script setup lang="ts">
import type { AgentContextUsage, AgentMessage, AgentRetryState, AgentStatus, ServerRecord } from "~/types/app";
import type { PendingAgentAttachment, UploadState } from "~/types/ui";
import AgentPanel from "~/components/workspace/AgentPanel.vue";

// Conversation state stays with the page; the dashboard only arranges it.
const props = defineProps<{
  servers: ServerRecord[];
  serversLoaded: boolean;
  serversError: string;
  historyLoading: boolean;
  contextLoading: boolean;
  contextError: string;
  historyError: string;
  configLoading: boolean;
  configError: string;
  messages: AgentMessage[];
  input: string;
  busy: boolean;
  status: AgentStatus;
  retry: AgentRetryState | null;
  retryMessage: string;
  retryNowSending: boolean;
  contextUsage: AgentContextUsage;
  contextRemainingLabel: string;
  contextRingStyle: Record<string, string>;
  outputLoading: boolean;
  outputLoadingText: string;
  modelName?: string;
  modelOptions?: string[];
  reasoningEffort: "minimal" | "low" | "medium" | "high";
  autoConfirm: boolean;
  attachments: PendingAgentAttachment[];
  upload: UploadState;
  uploadDetail: (upload: UploadState) => string;
  scrollToBottomVisible: boolean;
  statusText: (status: ServerRecord["status"]) => string;
}>();

const emit = defineEmits<{
  "open-instance": [serverId: string];
  create: [];
  "reload-history": [];
  "reload-servers": [];
  send: [];
  cancel: [];
  clear: [];
  compress: [];
  retry: [];
  "reuse-message": [content: string];
  "message-scroll": [];
  "scroll-to-bottom": [];
  "remove-attachment": [uploadId: string];
  "update:input": [value: string];
  "update:model-name": [value: string];
  "update:reasoning-effort": [value: "minimal" | "low" | "medium" | "high"];
  "update:auto-confirm": [value: boolean];
  upload: [event: Event];
  "upload-requested": [];
}>();

const agentPanel = ref<InstanceType<typeof AgentPanel> | null>(null);

const hasServers = computed(() => props.servers.length > 0);
const instanceFilter = ref<"all" | "running" | "attention">("all");
const filters = [
  { id: "all", label: "全部" },
  { id: "running", label: "运行中" },
  { id: "attention", label: "异常" }
] as const;

const quickPrompts = [
  { icon: "rocket" as const, label: "部署整合包", text: "我想部署整合包，先帮我确认包名和版本" },
  { icon: "instances" as const, label: "巡检实例", text: "我的实例现在都在跑吗？帮我检查一下" },
  { icon: "warning" as const, label: "排查崩溃", text: "帮我看看有没有实例崩溃了" }
];

const panelPlaceholder = computed(() => {
  if (props.busy) return "可以先草拟下一条消息…";
  return "部署、启动、排错，说说你想做什么…";
});

function serverStatusTone(status: ServerRecord["status"]) {
  if (status === "running") return "ok";
  if (status === "crashed" || status === "orphaned") return "danger";
  if (status === "starting" || status === "stopping") return "busy";
  return "idle";
}

/** Instance recommendation: attention first, then running, then stopped. */
const recommended = computed(() => {
  const rank: Record<ServerRecord["status"], number> = { crashed: 0, orphaned: 1, running: 2, starting: 3, stopping: 4, stopped: 5 };
  return [...props.servers].sort((a, b) => rank[a.status] - rank[b.status]);
});

const visibleServers = computed(() => recommended.value.filter((server) => {
  if (instanceFilter.value === "running") return server.status === "running";
  if (instanceFilter.value === "attention") return server.status === "crashed" || server.status === "orphaned";
  return true;
}));

function canQuickStart(server: ServerRecord) {
  return server.status === "stopped" || server.status === "crashed";
}

function sendWith(text: string) {
  emit("update:input", text);
  void nextTick(() => { emit("send"); agentPanel.value?.focusInput(); });
}

function serverName(serverId: string) {
  return props.servers.find((server) => server.id === serverId)?.name ?? serverId;
}

function focusServerIdFor(message: AgentMessage) {
  return message.focusServerId ?? null;
}

defineExpose({
  focusInput: () => agentPanel.value?.focusInput(),
  getMessageList: () => agentPanel.value?.getMessageList(),
  scrollToBottom: (force = false) => agentPanel.value?.scrollToBottom(force),
  openUploadPicker: () => agentPanel.value?.openUploadPicker()
});
</script>

<template>
  <main class="dashboard-main">
    <header class="dashboard-welcome">
      <div class="welcome-copy">
        <p class="dashboard-eyebrow"><span class="dashboard-eyebrow-mark" /> WORKSPACE / 概览</p>
        <h1>工作台<span class="dashboard-title-dot">.</span></h1>
        <p class="welcome-sub">管理你的世界，把琐事交给 Agent。</p>
      </div>
      <button class="dashboard-create" type="button" :disabled="busy" @click="emit('create')">
        <AppIcon name="plus" :size="16" /> 对话建服
      </button>
    </header>

    <div class="dashboard-layout">
    <section class="dashboard-section dashboard-instances" aria-labelledby="dashboard-instances-title">
      <div class="dashboard-section-head">
        <h2 id="dashboard-instances-title">我的实例 <span class="dashboard-count">{{ serversLoaded ? servers.length : '—' }}</span></h2>
        <AppIcon name="instances" :size="17" />
      </div>

      <div class="dashboard-filters" role="group" aria-label="筛选实例">
        <button v-for="filter in filters" :key="filter.id" type="button" :aria-pressed="instanceFilter === filter.id" @click="instanceFilter = filter.id">{{ filter.label }}</button>
      </div>

      <AsyncPlaceholder v-if="!serversLoaded && serversError" :error="serversError" @retry="emit('reload-servers')" />
      <div v-else-if="!serversLoaded" class="dashboard-loading" role="status" aria-label="正在加载实例" aria-busy="true">
        <div v-for="item in 3" :key="item" class="instance-skeleton"><span /><span /><span /></div>
      </div>
      <div v-else-if="!hasServers" class="dashboard-empty">
        <span class="dashboard-empty-icon"><AppIcon name="cube" :size="28" /></span>
        <h3>第一个世界，从这里开始</h3>
        <p>告诉 Agent 你想开什么服。</p>
        <button type="button" :disabled="busy" @click="emit('create')"><AppIcon name="plus" :size="15" /> 对话建服</button>
      </div>
      <div v-else-if="!visibleServers.length" class="dashboard-empty dashboard-filter-empty">
        <AppIcon :name="instanceFilter === 'attention' ? 'check' : 'server'" :size="24" />
        <h3>{{ instanceFilter === 'attention' ? '没有异常实例' : '暂无运行中的实例' }}</h3>
        <button type="button" @click="instanceFilter = 'all'">查看全部</button>
      </div>
      <div v-else class="instance-grid">
        <article v-for="server in visibleServers" :key="server.id" class="instance-card" :class="`tone-${serverStatusTone(server.status)}`">
          <div class="instance-card-head">
            <span class="instance-avatar"><AppIcon name="cube" :size="21" /></span>
            <div class="instance-card-title">
              <h3>{{ server.name }}</h3>
              <p>{{ server.modpackName || server.serverType || "Minecraft 服务端" }}</p>
            </div>
            <span class="instance-status" :class="`tone-${serverStatusTone(server.status)}`">
              <i class="dot" aria-hidden="true" />
              {{ statusText(server.status) }}
            </span>
          </div>

          <dl class="instance-facts">
            <div><dt>MC</dt><dd>{{ server.minecraftVersion || "—" }}</dd></div>
            <div><dt>内存</dt><dd>{{ server.maxMemory || "—" }}</dd></div>
            <div><dt>Java</dt><dd>{{ server.javaVersion || "—" }}</dd></div>
          </dl>

          <div class="instance-card-actions">
            <button class="instance-open" type="button" :aria-label="`管理 ${server.name}`" @click="emit('open-instance', server.id)">
              管理实例 <AppIcon name="arrowRight" :size="14" />
            </button>
            <button v-if="canQuickStart(server)" class="instance-start" type="button" :disabled="busy" :aria-label="`${server.status === 'crashed' ? '诊断并启动' : '启动'} ${server.name}`" @click="sendWith(server.status === 'crashed' ? `帮我排查并启动 ${server.name}` : `启动 ${server.name}`)">
              <AppIcon :name="server.status === 'crashed' ? 'tools' : 'play'" :size="13" />
              {{ server.status === "crashed" ? "诊断启动" : "启动" }}
            </button>
          </div>
        </article>
      </div>
    </section>

    <section class="dashboard-section dashboard-chat-section" aria-label="全局 Agent 助手">
      <AgentPanel
        ref="agentPanel"
        :attachments="props.attachments"
        :auto-confirm="props.autoConfirm"
        :busy="props.busy"
        :context-remaining-label="props.contextRemainingLabel"
        :context-ring-style="props.contextRingStyle"
        :context-usage="props.contextUsage"
        :input="props.input"
        :messages="props.messages"
        :history-loading="props.historyLoading"
        :context-loading="props.contextLoading"
        :context-error="props.contextError"
        :history-error="props.historyError"
        :config-loading="props.configLoading"
        :config-error="props.configError"
        :model-name="props.modelName"
        :model-options="props.modelOptions"
        :output-loading="props.outputLoading"
        :output-loading-text="props.outputLoadingText"
        panel-subtitle="全局会话"
        empty-title="有什么想做的？"
        empty-description="建服、巡检、排错，一句话开始。"
        :placeholder="panelPlaceholder"
        :reasoning-effort="props.reasoningEffort"
        :retry="props.retry"
        :retry-message="props.retryMessage"
        :retry-now-sending="props.retryNowSending"
        :scroll-to-bottom-visible="props.scrollToBottomVisible"
        :status="props.status"
        :upload="props.upload"
        :upload-detail="props.uploadDetail"
        :upload-session-id="'global'"
        :quick-prompts="quickPrompts"
        :focus-label-for="serverName"
        :focus-server-id-for="focusServerIdFor"
        @cancel="emit('cancel')"
        @reload-history="emit('reload-history')"
        @clear="emit('clear')"
        @compress="emit('compress')"
        @message-scroll="emit('message-scroll')"
        @open-instance="emit('open-instance', $event)"
        @remove-attachment="emit('remove-attachment', $event)"
        @retry="emit('retry')"
        @reuse-message="emit('reuse-message', $event)"
        @scroll-to-bottom="emit('scroll-to-bottom')"
        @send="emit('send')"
        @update:auto-confirm="emit('update:auto-confirm', $event)"
        @update:input="emit('update:input', $event)"
        @update:model-name="emit('update:model-name', $event)"
        @update:reasoning-effort="emit('update:reasoning-effort', $event)"
        @upload="emit('upload', $event)"
        @upload-requested="emit('upload-requested')"
      />
    </section>
    </div>
  </main>
</template>

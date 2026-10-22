<script setup lang="ts">
import type { AgentWorkflowProgress, AgentWorkflowStep, ServerSlotStatus } from "~/types/app";
import type { DeploymentProgressState, UploadState } from "~/types/ui";
import type { IconName } from "~/utils/icons";
import { resolveDeploymentStage } from "~/utils/deploymentProgress";

const props = defineProps<{
  dismissed: boolean;
  loading: boolean;
  loadError: string;
  serverName: string;
  state: DeploymentProgressState;
  slot: ServerSlotStatus | null;
  slotLoading: boolean;
  slotError: string;
  slotSize: (size: number) => string;
  slotUpload: UploadState;
  uploadBusy: boolean;
  slotUploadDetail: (upload: UploadState) => string;
  workflow: AgentWorkflowProgress | null;
}>();

const emit = defineEmits<{
  refresh: [];
  "open-agent": [];
  "upload-server-slot": [event: Event];
  "toggle-dismissed": [];
}>();

const slotUploadInput = ref<HTMLInputElement | null>(null);
const toggleButton = ref<HTMLButtonElement | null>(null);

const presentations: Record<DeploymentProgressState, { label: string; icon: IconName; tone: string; hint: string }> = {
  not_started: { label: "暂无部署任务", icon: "cube", tone: "neutral", hint: "告诉 Agent 想部署的版本或整合包，也可以先上传服务端包。" },
  ready: { label: "服务端包已就绪", icon: "archive", tone: "neutral", hint: "服务端包已保存，可在 Agent 对话中发起部署。" },
  running: { label: "正在部署", icon: "loader", tone: "active", hint: "Agent 正在处理部署任务，步骤会自动更新。" },
  waiting_confirmation: { label: "等待确认", icon: "clock", tone: "waiting", hint: "请先处理 Agent 的确认请求，确认后继续部署。" },
  retrying: { label: "等待重试", icon: "clock", tone: "waiting", hint: "模型连接暂时异常，Agent 将自动重试。" },
  progress: { label: "部署尚未完成", icon: "clock", tone: "waiting", hint: "当前流程尚未完成，可在 Agent 对话中查看结果并继续。" },
  completed: { label: "流程步骤已完成", icon: "check", tone: "success", hint: "流程步骤已完成；验收结果与未解决项请查看 Agent 报告，运行状态请查看控制台。" },
  failed: { label: "部署失败", icon: "warning", tone: "error", hint: "在 Agent 对话中查看失败原因并继续处理。" },
  cancelled: { label: "部署已中断", icon: "stop", tone: "waiting", hint: "任务已停止，可在 Agent 对话中说明下一步操作。" }
};
const presentation = computed(() => props.loading
  ? { label: "正在同步部署", icon: "loader" as const, tone: "neutral", hint: "正在读取部署记录与服务端包状态。" }
  : props.loadError && props.state === "not_started"
    ? { label: "部署状态未就绪", icon: "warning" as const, tone: "neutral", hint: "暂时无法读取部署记录，请在 Agent 中重试加载。" }
    : presentations[props.state]);
const workflowFinished = computed(() => ["completed", "failed", "cancelled"].includes(props.state));
const completedSteps = computed(() => props.workflow?.steps.filter((step) => step.status === "completed").length ?? 0);
const normalizedPercent = computed(() => props.state === "completed" ? 100 : clampPercent(props.workflow?.overallProgress ?? 0));
const uploadPercent = computed(() => clampPercent(props.slotUpload.percent));
const uploadLabel = computed(() => props.slotUpload.done ? "上传完成" : uploadPercent.value === 100 ? "正在保存服务端包" : "正在上传服务端包");
const compactLabel = computed(() => props.slotUpload.active ? uploadLabel.value : presentation.value.label);
const compactPercent = computed(() => props.slotUpload.active ? uploadPercent.value : props.workflow ? normalizedPercent.value : null);
const stage = computed(() => resolveDeploymentStage(props.workflow, props.state));
const currentTurn = computed(() => props.workflow?.turn);
const activeBranches = computed(() => props.workflow?.steps.filter((step) => currentTurn.value ? currentTurn.value.stepIds.includes(step.id) : step.status === "running") ?? []);
function isCurrent(id: string) { return !workflowFinished.value && (currentTurn.value ? currentTurn.value.stepIds.includes(id) : activeBranches.value.some((step) => step.id === id) || stage.value.current?.id === id); }
const stageTitle = computed(() => props.loading ? "正在读取部署记录…" : props.slotUpload.active ? uploadLabel.value
  : props.state === "completed" ? "所有部署阶段已完成"
    : stage.value.current?.label ?? (props.state === "not_started" ? "准备部署服务端" : presentation.value.label));
const stageCaption = computed(() => props.slotUpload.active ? "准备安装包"
  : currentTurn.value ? `Turn ${currentTurn.value.index + 1} / ${currentTurn.value.total}${activeBranches.value.length > 1 ? ' · 并行汇合' : ''}`
  : props.state === "completed" ? "部署结果"
    : stage.value.current ? `第 ${stage.value.index + 1} / ${props.workflow?.steps.length} 阶段`
      : props.workflow ? "等待阶段更新" : "部署准备");
const stageDetail = computed(() => props.slotUpload.active ? "上传仅保存安装包，完成后由 Agent 继续部署。"
   : props.workflow?.run?.waitingForJobs || currentTurn.value?.waitingForJobs ? "正在等待后台工具结束并核验结果；不会提前结束部署执行。"
  : props.state === "completed" ? presentation.value.hint
    : stage.value.current?.detail || presentation.value.hint);
const stageIcon = computed<IconName>(() => props.slotUpload.active ? "upload" : presentation.value.icon);
const nextStageLabel = computed(() => props.slotUpload.active ? "让 Agent 使用服务端包开始部署"
  : props.state === "completed" ? "在控制台查看服务端运行状态"
    : props.state === "waiting_confirmation" ? "在 Agent 中确认后继续当前阶段"
      : props.state === "retrying" ? "连接恢复后自动继续当前阶段"
        : props.state === "failed" || props.state === "cancelled" ? "在 Agent 中处理后继续部署"
          : stage.value.next?.label ?? (props.workflow ? "等待 Agent 更新后续阶段" : "在 Agent 中确认版本或整合包"));
const packageMeta = computed(() => {
  const slot = props.slot;
  if (!slot?.occupied) return "";
  const extension = slot.fileName?.match(/\.([^.]+)$/)?.[1]?.toUpperCase();
  const source = slot.source ? { user_upload: "手动上传", agent_upload: "Agent 保存", remote_download: "远程下载" }[slot.source] : "";
  return [extension, slot.size === null ? "" : props.slotSize(slot.size), source].filter(Boolean).join(" · ");
});
const packageUpdatedAt = computed(() => {
  if (!props.slot?.modifiedAt) return "";
  const date = new Date(props.slot.modifiedAt);
  return Number.isNaN(date.getTime()) ? props.slot.modifiedAt : date.toLocaleString();
});

function clampPercent(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function stepStatusText(step: AgentWorkflowStep) {
  if (step.status === "completed") return "已完成";
  if (step.status === "failed") return props.state === "cancelled" ? "已中断" : "失败";
  if (step.id === stage.value.current?.id && !workflowFinished.value) {
    if (props.state === "waiting_confirmation") return "等待确认";
    if (props.state === "retrying") return "等待重试";
    if (step.status === "pending") return props.state === "running" ? "即将开始" : "待继续";
  }
  if (step.status === "pending") return workflowFinished.value ? "未执行" : "待执行";
  if (props.state === "waiting_confirmation") return "等待确认";
  if (props.state === "retrying") return "等待重试";
  return props.state === "running" ? "进行中" : "待继续";
}

function togglePanel() {
  emit("toggle-dismissed");
  void nextTick(() => toggleButton.value?.focus({ preventScroll: true }));
}

function collapsePanel() {
  if (!props.dismissed) togglePanel();
}
</script>

<template>
  <div class="deployment-progress-shell" :class="[`deployment-tone-${props.slotUpload.active ? 'active' : presentation.tone}`, { 'is-collapsed': props.dismissed }]" @keydown.esc.stop.prevent="collapsePanel">
    <span class="visually-hidden" role="status" aria-live="polite">{{ props.serverName }}：{{ compactLabel }}，{{ stageCaption }}，{{ stageTitle }}</span>
    <button
      ref="toggleButton"
      type="button"
      class="deployment-progress-toggle"
      :title="`${props.serverName} · ${compactLabel} · ${stageTitle}`"
      :aria-label="`${props.dismissed ? '展开' : '收起'}部署面板：${compactLabel}，${stageTitle}`"
      aria-controls="deployment-progress-card"
      :aria-expanded="!props.dismissed"
      @click="togglePanel"
    >
      <AppIcon :name="props.loading ? 'loader' : 'cube'" :spin="props.loading" />
      <strong id="deployment-panel-title">部署</strong>
      <span class="deployment-toggle-status" :class="{ 'is-uploading': props.slotUpload.active }">
        <span class="deployment-status-dot" /><span>{{ compactLabel }}</span>
      </span>
      <span v-if="stage.current && !props.slotUpload.active" class="deployment-toggle-stage">{{ stage.index + 1 }}/{{ props.workflow?.steps.length }}<span class="deployment-toggle-stage-label"> · {{ stage.current.label }}</span></span>
      <span v-if="compactPercent !== null" class="deployment-toggle-percent">{{ compactPercent }}%</span>
      <AppIcon class="deployment-toggle-chevron" :name="props.dismissed ? 'chevronUp' : 'chevronDown'" :size="14" />
      <span v-if="compactPercent !== null" class="deployment-header-meter" aria-hidden="true"><span :style="{ width: `${compactPercent}%` }" /></span>
    </button>

    <section
      id="deployment-progress-card"
      class="deployment-progress-card"
      aria-labelledby="deployment-panel-title"
      :inert="props.dismissed"
      :aria-hidden="props.dismissed"
    >
      <div class="deployment-panel-body">
        <AsyncPlaceholder v-if="props.loading" label="正在同步部署记录" />
        <section v-else class="deployment-overview" aria-labelledby="deployment-state-title">
          <div class="deployment-stage-card">
            <div class="deployment-stage-caption"><span>{{ stageCaption }}</span><span class="deployment-stage-state"><AppIcon :name="stageIcon" :spin="props.state === 'running' && !props.slotUpload.active" :size="12" />{{ compactLabel }}</span></div>
            <div class="deployment-state-heading">
              <h2 id="deployment-state-title">{{ stageTitle }}</h2>
              <span v-if="compactPercent !== null" class="deployment-overall-percent">{{ compactPercent }}<small>%</small><span>{{ props.slotUpload.active ? '上传进度' : '总进度' }}</span></span>
            </div>
            <p class="deployment-description">{{ stageDetail }}</p>
            <p v-if="activeBranches.length > 1" class="deployment-description">当前分支：{{ activeBranches.map(step => `${step.label}（${stepStatusText(step)}）`).join(' ∥ ') }}。依赖结果就绪后继续后续步骤。</p>
            <div class="deployment-next-stage"><span>{{ props.state === 'completed' ? '接下来' : ['waiting_confirmation', 'retrying', 'failed', 'cancelled'].includes(props.state) ? '如何继续' : '下一步' }}</span><AppIcon name="arrowRight" :size="12" /><strong>{{ nextStageLabel }}</strong></div>
          </div>

          <div v-if="props.workflow?.steps.length" class="deployment-section-heading deployment-flow-heading">
            <h3 :title="props.workflow.title">部署流程</h3><span>{{ completedSteps }} / {{ props.workflow.steps.length }} 阶段已完成</span>
          </div>
          <div v-if="props.workflow" class="deployment-flow-meter" role="progressbar" aria-label="部署总进度" :aria-valuenow="normalizedPercent" :aria-valuetext="`${stageTitle}，总进度 ${normalizedPercent}%`" :aria-valuemin="0" :aria-valuemax="100">
            <span v-for="step in props.workflow.steps" :key="step.id" :class="[`deployment-flow-${step.status}`, { 'is-current': isCurrent(step.id) }]" :title="`${step.label}：${stepStatusText(step)}`"><span :style="{ width: `${step.status === 'completed' ? 100 : clampPercent(step.progress)}%` }" /></span>
          </div>
          <ol v-if="props.workflow?.steps.length" class="deployment-timeline" aria-label="部署步骤">
            <li
              v-for="(step, index) in props.workflow.steps"
              :key="step.id"
              class="deployment-step"
              :class="[`deployment-step-${step.status}`, { 'is-current': isCurrent(step.id), 'is-interrupted': props.state === 'cancelled' }]"
              :aria-current="isCurrent(step.id) ? 'step' : undefined"
              :data-workflow-step-id="step.id"
            >
              <span class="deployment-step-marker" aria-hidden="true">
                <AppIcon v-if="step.status === 'completed'" name="check" :size="13" />
                <AppIcon v-else-if="step.status === 'failed'" :name="props.state === 'cancelled' ? 'minus' : 'close'" :size="13" />
                <AppIcon v-else-if="step.status === 'running' && props.state === 'running'" name="loader" :size="13" spin />
                <span v-else>{{ String(index + 1).padStart(2, '0') }}</span>
              </span>
              <div class="deployment-step-copy">
                <div class="deployment-step-heading"><strong>{{ step.label }}<small v-if="currentTurn && step.roundIndex !== undefined"> · T{{ step.roundIndex + 1 }}</small><small v-if="step.parallelGroup"> · 可并行</small></strong><span>{{ stepStatusText(step) }}</span></div>
              </div>
            </li>
          </ol>
        </section>

        <section class="deployment-package" aria-labelledby="deployment-package-title">
          <div class="deployment-section-heading">
            <h3 id="deployment-package-title">服务端包</h3>
            <button
              type="button"
              class="deployment-icon-button"
              title="刷新服务端包"
              aria-label="刷新服务端包"
              :disabled="props.slotLoading || props.uploadBusy"
              @click="emit('refresh')"
            ><AppIcon name="refresh" :size="14" :spin="props.slotLoading" /></button>
          </div>

          <div v-if="props.slotUpload.active" class="deployment-upload">
            <div class="deployment-upload-heading"><span>{{ uploadLabel }}</span><strong>{{ uploadPercent }}%</strong></div>
            <p class="deployment-package-name" :title="props.slotUpload.fileName">{{ props.slotUpload.fileName }}</p>
            <div class="deployment-meter" role="progressbar" aria-label="服务端包上传进度" :aria-valuenow="uploadPercent" :aria-valuemin="0" :aria-valuemax="100"><span :style="{ width: `${uploadPercent}%` }" /></div>
            <small>{{ props.slotUploadDetail(props.slotUpload) }}</small>
          </div>
          <template v-else>
            <div class="deployment-package-file">
              <span class="deployment-package-icon"><AppIcon :name="props.slot?.occupied ? 'archive' : 'upload'" :size="20" /></span>
              <div class="deployment-package-copy">
                <p class="deployment-package-name" :title="props.slot?.fileName ?? undefined">{{ props.slot?.occupied ? props.slot.fileName : props.slotLoading ? '正在读取服务端包…' : props.slot ? '尚未添加服务端包' : '服务端包状态未知' }}</p>
                <small>{{ props.slot?.occupied ? packageMeta : props.slot ? '上传本地文件，或让 Agent 查找并下载。' : '可刷新状态，或直接上传本地文件。' }}</small>
              </div>
              <button type="button" class="deployment-upload-button" :class="{ primary: !props.slot?.occupied }" :disabled="props.uploadBusy || props.slotLoading" @click="slotUploadInput?.click()">
                <AppIcon name="upload" :size="14" />{{ props.slot?.occupied ? '替换' : '上传' }}
              </button>
            </div>
            <details v-if="props.slot?.occupied" class="deployment-package-details">
              <summary><AppIcon name="chevronRight" :size="12" />文件详情</summary>
              <dl>
                <div v-if="props.slot.filePath"><dt>文件路径</dt><dd>{{ props.slot.filePath }}</dd></div>
                <div v-if="packageUpdatedAt"><dt>更新时间</dt><dd>{{ packageUpdatedAt }}</dd></div>
              </dl>
              <p>此处保存原始安装包；上传新文件会替换当前包。</p>
            </details>
          </template>
          <p v-if="props.slotError" class="deployment-package-error" role="alert"><AppIcon name="warning" :size="14" />{{ props.slotError }}</p>
          <input ref="slotUploadInput" class="visually-hidden" type="file" tabindex="-1" aria-label="上传服务端包" :disabled="props.uploadBusy" @change="emit('upload-server-slot', $event)" />
        </section>
      </div>

      <footer class="deployment-panel-footer">
        <p>{{ props.slotUpload.active ? '上传仅保存安装包，完成后可让 Agent 继续部署。' : props.workflow ? presentation.hint : '部署任务由 Agent 对话发起。' }}</p>
        <button type="button" class="deployment-agent-link" @click="emit('open-agent')">前往 Agent<AppIcon name="arrowRight" :size="14" /></button>
      </footer>
    </section>
  </div>
</template>

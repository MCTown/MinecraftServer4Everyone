<script setup lang="ts">
import type { AgentWorkflowProgress, AgentWorkflowStepStatus, ServerSlotStatus } from "~/types/app";
import type { UploadState } from "~/types/ui";

const props = defineProps<{
  dismissed: boolean;
  label: string;
  percent: number;
  slot: ServerSlotStatus | null;
  slotSize: (size: number) => string;
  slotUpload: UploadState;
  slotUploadDetail: (upload: UploadState) => string;
  status: string;
  workflow: AgentWorkflowProgress | null;
  workflowStatusClass: (status: AgentWorkflowStepStatus) => string;
  workflowStatusText: (status: AgentWorkflowStepStatus) => string;
}>();

const emit = defineEmits<{
  refresh: [];
  "upload-server-slot": [event: Event];
  "toggle-dismissed": [];
}>();

const slotUploadInput = ref<HTMLInputElement | null>(null);

function openSlotUploadPicker() {
  slotUploadInput.value?.click();
}

function slotFileType(slot: ServerSlotStatus | null) {
  if (!slot?.fileName) return "未占用";
  const extension = slot.fileName.match(/\.([^.]+)$/)?.[1];
  return extension ? `.${extension.toUpperCase()}` : "无扩展名";
}

function slotSourceText(slot: ServerSlotStatus | null) {
  if (!slot?.source) return "历史文件 / 未记录";
  return {
    user_upload: "用户上传",
    agent_upload: "Agent 写入",
    remote_download: "远端下载"
  }[slot.source];
}

function slotUpdatedText(slot: ServerSlotStatus | null) {
  if (!slot?.modifiedAt) return "暂无";
  const date = new Date(slot.modifiedAt);
  return Number.isNaN(date.getTime()) ? slot.modifiedAt : date.toLocaleString();
}
</script>

<template>
  <div class="deployment-progress-shell" :class="[`workflow-${props.status}`, { dismissed: props.dismissed }]">
    <div class="deployment-progress-panel">
      <button type="button" class="deployment-progress-sticky-caret" :aria-label="props.dismissed ? '显示部署进度' : '隐藏部署进度'" @click="emit('toggle-dismissed')"><span aria-hidden="true" /></button>
      <section class="card stack deployment-progress-card" :class="`workflow-${props.status}`" role="status" aria-live="polite">
        <div class="card-header deployment-progress-header">
          <div><p class="eyebrow">Deployment</p></div>
        </div>
        <div class="server-slot-card" :class="{ occupied: props.slot?.occupied }">
          <div class="server-slot-content">
            <div class="server-slot-heading">
              <div>
                <p class="eyebrow">Server Package</p>
                <strong>{{ props.slot?.occupied ? "已准备服务端包" : "等待服务端包" }}</strong>
              </div>
              <span class="status-pill" :class="props.slot?.occupied ? 'status-running' : 'risk-medium'">{{ props.slot?.occupied ? "OCCUPIED" : "EMPTY" }}</span>
            </div>
            <dl class="server-slot-details">
              <div><dt>文件</dt><dd :title="props.slot?.fileName ?? undefined">{{ props.slot?.fileName ?? "暂无文件" }}</dd></div>
              <div><dt>类型</dt><dd>{{ slotFileType(props.slot) }}</dd></div>
              <div><dt>槽位目录</dt><dd :title="props.slot?.directory">{{ props.slot?.directory ?? "读取中" }}</dd></div>
              <div><dt>文件路径</dt><dd :title="props.slot?.filePath ?? undefined">{{ props.slot?.filePath ?? "暂无文件" }}</dd></div>
              <div><dt>占用 / 容量</dt><dd>{{ props.slot?.occupied ? "1" : "0" }} / 1 个文件</dd></div>
              <div><dt>文件大小</dt><dd>{{ props.slot?.size === null || props.slot?.size === undefined ? "未知大小" : props.slotSize(props.slot.size) }}</dd></div>
              <div><dt>来源</dt><dd>{{ slotSourceText(props.slot) }}</dd></div>
              <div><dt>更新时间</dt><dd>{{ slotUpdatedText(props.slot) }}</dd></div>
            </dl>
            <small class="muted server-slot-note">上传或 Agent 下载会替换当前槽位文件，服务端部署始终从此槽位读取。</small>
            <div v-if="props.slotUpload.active" class="upload-progress server-slot-upload-progress" role="status" aria-live="polite">
              <div class="row"><strong>{{ props.slotUpload.done ? "上传完成" : "正在上传" }} {{ props.slotUpload.fileName }}</strong><span>{{ props.slotUpload.percent }}%</span></div>
              <div class="progress-track"><span :style="{ width: `${props.slotUpload.percent}%` }" /></div>
              <small class="muted">{{ props.slotUploadDetail(props.slotUpload) }}</small>
            </div>
          </div>
          <div class="server-slot-actions">
            <input ref="slotUploadInput" class="visually-hidden" type="file" tabindex="-1" @change="emit('upload-server-slot', $event)" />
            <button type="button" class="primary" :disabled="props.slotUpload.active" @click="openSlotUploadPicker">{{ props.slotUpload.active ? "上传中" : "上传服务端" }}</button>
            <button type="button" :disabled="props.slotUpload.active" @click="emit('refresh')">刷新状态</button>
          </div>
        </div>
        <div class="workflow-progress-panel" :class="`workflow-${props.status}`">
          <div class="row workflow-head"><strong>{{ props.workflow?.title ?? "服务端部署" }}</strong><span>{{ props.percent }}%</span></div>
          <div class="progress-track"><span :style="{ width: `${props.percent}%` }" /></div>
          <div v-if="props.workflow" class="workflow-steps" tabindex="0" aria-label="部署步骤">
            <div v-for="step in props.workflow.steps" :key="step.id" class="workflow-step" :class="[`step-${step.status}`, { active: step.id === props.workflow?.currentStepId }]" :data-workflow-step-id="step.id">
              <div class="row">
                <strong>{{ step.label }}</strong>
                <span v-if="step.status === 'failed'" class="status-pill" :class="props.workflowStatusClass(step.status)">{{ props.workflowStatusText(step.status) }}</span>
              </div>
              <div class="progress-track"><span :style="{ width: `${step.progress}%` }" /></div>
              <small class="muted">{{ step.detail || `${step.progress}%` }}</small>
            </div>
          </div>
          <small v-else class="muted">当前服务端包已准备好，可继续启动或调整配置。</small>
        </div>
      </section>
    </div>
  </div>
</template>

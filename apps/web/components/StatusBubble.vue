<script setup lang="ts">
type StatusBubbleType = "idle" | "loading" | "success" | "error";

interface AgentDownloadProgress {
  id: string;
  url: string;
  fileName: string;
  destinationPath: string;
  loadedBytes: number;
  totalBytes: number | null;
  percent: number;
  status: "starting" | "downloading" | "completed" | "cancelled" | "failed";
  error?: string;
}

interface StatusBubbleItem {
  id: number;
  message: string;
  type?: StatusBubbleType;
  durationMs?: number;
  progressKey?: number;
  download?: AgentDownloadProgress;
  actionLabel?: string;
  actionKey?: string;
}

defineProps<{
  items: StatusBubbleItem[];
}>();

defineEmits<{
  action: [item: StatusBubbleItem];
}>();

function progressStyle(durationMs?: number) {
  return {
    "--toast-duration": `${Math.max(durationMs ?? 0, 0)}ms`
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function downloadDetail(download: AgentDownloadProgress) {
  if (download.error) return download.error;
  if (download.totalBytes) return `${formatBytes(Math.min(download.loadedBytes, download.totalBytes))} / ${formatBytes(download.totalBytes)}`;
  if (download.loadedBytes > 0) return `已下载 ${formatBytes(download.loadedBytes)}`;
  return download.destinationPath;
}
</script>

<template>
  <TransitionGroup name="toast" tag="div" class="toast-stack">
    <div v-for="item in items" :key="item.id" class="toast-bubble" :class="`toast-${item.type ?? 'idle'}`" role="status" aria-live="polite" :style="progressStyle(item.durationMs)">
      <template v-if="item.download">
        <div class="toast-download-head">
          <span class="toast-message">{{ item.message }}</span>
          <span>{{ item.download.percent }}%</span>
        </div>
        <div class="toast-download-track"><span :style="{ width: `${item.download.percent}%` }" /></div>
        <small>{{ downloadDetail(item.download) }}</small>
      </template>
      <span v-else class="toast-message">{{ item.message }}</span>
      <button v-if="item.actionLabel" class="toast-action" type="button" @click="$emit('action', item)">{{ item.actionLabel }}</button>
      <span v-if="item.durationMs && item.durationMs > 0" :key="`${item.id}-${item.progressKey ?? 0}`" class="toast-border-progress" aria-hidden="true" />
    </div>
  </TransitionGroup>
</template>

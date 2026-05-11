<script setup lang="ts">
type StatusBubbleType = "idle" | "loading" | "success" | "error";

interface StatusBubbleItem {
  id: number;
  message: string;
  type?: StatusBubbleType;
  durationMs?: number;
  progressKey?: number;
}

defineProps<{
  items: StatusBubbleItem[];
}>();

function progressStyle(durationMs?: number) {
  return {
    "--toast-duration": `${Math.max(durationMs ?? 0, 0)}ms`
  };
}
</script>

<template>
  <TransitionGroup name="toast" tag="div" class="toast-stack">
    <div v-for="item in items" :key="item.id" class="toast-bubble" :class="`toast-${item.type ?? 'idle'}`" role="status" aria-live="polite" :style="progressStyle(item.durationMs)">
      <span class="toast-message">{{ item.message }}</span>
      <span v-if="item.durationMs && item.durationMs > 0" :key="`${item.id}-${item.progressKey ?? 0}`" class="toast-border-progress" aria-hidden="true" />
    </div>
  </TransitionGroup>
</template>

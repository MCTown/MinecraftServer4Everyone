<script setup lang="ts">
withDefaults(defineProps<{
  label?: string;
  variant?: "list" | "conversation" | "form" | "editor" | "compact";
  rows?: number;
  error?: string;
}>(), { label: "正在加载…", variant: "list", rows: 3, error: "" });
defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="async-placeholder" :class="[`async-${variant}`, { 'async-failed': error }]" role="status" aria-live="polite" :aria-busy="!error">
    <div class="async-placeholder-label"><AppIcon :name="error ? 'warning' : 'loader'" :spin="!error" :size="15" /><span>{{ error ? '加载失败，请重试' : label }}</span><button v-if="error" type="button" @click="$emit('retry')">重试</button></div>
    <template v-if="!error && variant !== 'compact'">
      <div v-for="row in rows" :key="row" class="async-skeleton-row" aria-hidden="true"><span class="async-skeleton async-skeleton-icon" /><div><span class="async-skeleton async-skeleton-title" /><span class="async-skeleton async-skeleton-line" /><span v-if="variant === 'conversation' || variant === 'editor'" class="async-skeleton async-skeleton-line short" /></div></div>
    </template>
  </div>
</template>

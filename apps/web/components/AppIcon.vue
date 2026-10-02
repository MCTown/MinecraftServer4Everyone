<script setup lang="ts">
import { iconPaths, type IconName } from "~/utils/icons";

const props = defineProps<{
  name: IconName;
  size?: number;
  label?: string;
  spin?: boolean;
}>();
</script>

<template>
  <svg
    class="app-icon"
    :class="{ 'app-icon-spinning': props.spin }"
    :style="props.size ? { '--icon-size': `${props.size}px` } : undefined"
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="props.label ? undefined : true"
    :aria-label="props.label"
    :role="props.label ? 'img' : undefined"
    focusable="false"
  >
    <path v-for="(path, index) in iconPaths[props.name]" :key="index" :d="path" />
  </svg>
</template>

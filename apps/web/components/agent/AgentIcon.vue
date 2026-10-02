<script setup lang="ts">
import type { IconName } from "~/utils/icons";

defineProps<{ name: string }>();
// Preserve the conversation API while using the shared application glyphs.
const names: Record<string, IconName> = {
  spark: "sparkles", brain: "brain", tool: "tools", chevron: "chevronRight",
  check: "check", error: "warning", stop: "stop", retry: "refresh", copy: "copy",
  down: "arrowDown", send: "arrowUp", attach: "attachment", close: "close",
  clock: "clock", expand: "unfold", collapse: "fold", trash: "trash",
  compress: "compress", file: "file"
};
</script>

<template>
  <AppIcon class="agent-icon" :name="names[name] ?? 'tools'" />
</template>

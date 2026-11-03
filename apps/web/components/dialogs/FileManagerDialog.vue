<script setup lang="ts">
import type { ServerRecord } from "~/types/app";
import FileWorkspace from "~/components/files/FileWorkspace.client.vue";

const props = defineProps<{ server: ServerRecord; currentPath: string }>();
const emit = defineEmits<{ close: []; "path-change": [path: string] }>();
const closeButton = ref<HTMLButtonElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
const workspace = ref<{ refresh(): Promise<void>; canLeave(): boolean } | null>(null);
const busy = ref(false);
function focusInitialAction() { closeButton.value?.focus(); }
function requestClose() { if (workspace.value?.canLeave() !== false) emit("close"); }
function handleKeydown(event: KeyboardEvent) {
  // VueFinder teleports its own dialogs to body; Escape belongs to that dialog.
  if (event.key === "Escape" && !document.querySelector(".vuefinder__modal-layout")) { event.preventDefault(); requestClose(); }
  if (event.key !== "Tab" || !dialog.value || document.querySelector(".vuefinder__modal-layout")) return;
  const focusable = [...dialog.value.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select, textarea, [tabindex='0']")].filter((item) => item.offsetParent !== null);
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
defineExpose({ focusInitialAction, requestClose, refresh: () => workspace.value?.refresh() });
</script>

<template>
  <section ref="dialog" class="card finder-dialog" role="dialog" aria-modal="true" :aria-label="`${props.server.name} 文件管理器`" @keydown="handleKeydown">
    <header class="finder-dialog-header"><div><span class="finder-heading-icon"><AppIcon name="folder" /></span><div><h2>{{ props.server.name }} <span>文件</span></h2><p>实例目录 · 重名文件不会自动覆盖</p></div></div><div><span v-if="busy" class="finder-working" role="status"><AppIcon name="loader" spin />正在处理</span><button ref="closeButton" type="button" :disabled="busy" aria-label="关闭文件管理器" @click="requestClose"><AppIcon name="close" /></button></div></header>
    <ClientOnly><FileWorkspace :id="`instance-files-${props.server.id}`" ref="workspace" :api-path="`/api/servers/${props.server.id}/files/manager`" :initial-path="props.currentPath" @path-change="emit('path-change', $event)" @busy-change="busy = $event" /><template #fallback><AsyncPlaceholder label="正在加载文件管理器" :rows="7" /></template></ClientOnly>
  </section>
</template>

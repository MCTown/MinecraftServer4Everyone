<script setup lang="ts">
import type { ServerRecord } from "~/types/app";
import type { IconName } from "~/utils/icons";

type ServerAction = "start" | "stop" | "restart" | "kill";

const props = defineProps<{
  server: ServerRecord;
  statusClass: string;
  statusText: string;
  canRunAction: (action: ServerAction) => boolean;
}>();

const emit = defineEmits<{
  action: [action: ServerAction];
  "open-config": [];
  "open-files": [];
  "open-map-editor": [];
}>();

const mapEditorButton = ref<HTMLButtonElement | null>(null);
const filesButton = ref<HTMLButtonElement | null>(null);
const actionMenu = ref<HTMLElement | null>(null);
const moreButton = ref<HTMLButtonElement | null>(null);
const menuOpen = ref(false);
const menuId = useId();
const primaryAction = computed<{ action: ServerAction; label: string; icon: IconName }>(() => {
  if (props.server.status === "stopping") return { action: "stop", label: "停止中", icon: "loader" };
  if (props.server.status === "running" || props.server.status === "starting") return { action: "stop", label: "停止", icon: "stop" };
  if (props.server.status === "orphaned") return { action: "restart", label: "重启", icon: "restart" };
  return { action: "start", label: "启动", icon: "play" };
});
const statusIcon = computed<IconName>(() => {
  if (props.server.status === "starting" || props.server.status === "stopping") return "loader";
  if (props.server.status === "running") return "check";
  if (props.server.status === "crashed" || props.server.status === "orphaned") return "warning";
  return "power";
});

function closeMenu(restoreFocus = false) {
  menuOpen.value = false;
  if (restoreFocus) moreButton.value?.focus();
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) void nextTick(() => {
    actionMenu.value?.querySelector<HTMLButtonElement>(".server-action-popover button:not(:disabled)")?.focus();
  });
}

function runAction(action: ServerAction) {
  if (!props.canRunAction(action)) return;
  closeMenu(true);
  emit("action", action);
}

function dismissOutside(event: Event) {
  if (menuOpen.value && event.target instanceof Node && !actionMenu.value?.contains(event.target)) closeMenu();
}

watch(() => props.server.id, () => closeMenu());
onMounted(() => {
  document.addEventListener("pointerdown", dismissOutside);
  document.addEventListener("focusin", dismissOutside);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", dismissOutside);
  document.removeEventListener("focusin", dismissOutside);
});

defineExpose({
  focusMapEditorTrigger: () => mapEditorButton.value?.focus(),
  focusFilesTrigger: () => filesButton.value?.focus()
});
</script>

<template>
  <header class="instance-topbar instance-toolbar card">
    <div class="instance-title-block">
      <p class="eyebrow">服务端<span v-if="props.server.minecraftVersion"> / MC {{ props.server.minecraftVersion }}</span></p>
      <div class="instance-heading-row">
        <h1 :title="props.server.name">{{ props.server.name }}</h1>
        <span class="instance-status-chip" :class="props.statusClass">
          <AppIcon :name="statusIcon" :size="12" :spin="statusIcon === 'loader'" />
          {{ props.statusText }}
        </span>
      </div>
    </div>
    <div class="instance-actions">
      <div class="instance-tool-group" role="group" aria-label="服务端工具">
        <button ref="filesButton" type="button" title="文件管理" aria-label="文件管理" @click="emit('open-files')">
          <AppIcon name="folder" :size="15" /> 文件
        </button>
        <button ref="mapEditorButton" type="button" title="地图编辑器" aria-label="地图编辑器" @click="emit('open-map-editor')">
          <AppIcon name="map" :size="15" /> 地图
        </button>
        <button type="button" title="服务端配置" aria-label="服务端配置" @click="emit('open-config')">
          <AppIcon name="sliders" :size="15" /> 配置
        </button>
      </div>

      <span class="instance-action-divider" aria-hidden="true" />

      <button class="server-primary-control" :class="{ 'is-stop': primaryAction.action === 'stop' }" type="button" :disabled="!props.canRunAction(primaryAction.action) || props.server.status === 'stopping'" :aria-label="`${primaryAction.label}服务端`" @click="emit('action', primaryAction.action)">
        <AppIcon :name="primaryAction.icon" :size="14" :spin="primaryAction.icon === 'loader'" />
        {{ primaryAction.label }}
      </button>

      <div ref="actionMenu" class="server-more-actions" @keydown.esc.stop.prevent="closeMenu(true)">
        <button ref="moreButton" class="server-more-trigger" type="button" title="更多操作" aria-label="更多操作" :aria-expanded="menuOpen" :aria-controls="menuId" @click="toggleMenu">
          <AppIcon name="moreHorizontal" :size="18" />
        </button>
        <div v-if="menuOpen" :id="menuId" class="server-action-popover" role="group" aria-label="更多服务端操作">
          <p class="server-action-popover-label">服务端操作</p>
          <button type="button" :disabled="!props.canRunAction('restart')" @click="runAction('restart')">
            <AppIcon name="restart" :size="15" /> 重启服务端
          </button>
          <div class="server-action-popover-divider" />
          <button class="server-force-stop" type="button" :disabled="!props.canRunAction('kill')" @click="runAction('kill')">
            <AppIcon name="terminate" :size="15" /> 强制结束
          </button>
          <p class="server-action-warning">可能丢失未保存的数据</p>
        </div>
      </div>
    </div>
  </header>
</template>

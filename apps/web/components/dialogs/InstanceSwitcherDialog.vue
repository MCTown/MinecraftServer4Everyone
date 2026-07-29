<script setup lang="ts">
import type { ServerRecord } from "~/types/app";

const props = defineProps<{
  open: boolean;
  selectedServer: ServerRecord | null;
  selectedServerId: string;
  servers: ServerRecord[];
  statusText: (status: ServerRecord["status"]) => string;
}>();

const emit = defineEmits<{
  close: [];
  "after-leave": [];
  create: [];
  delete: [server: ServerRecord];
  select: [id: string];
}>();

const dialog = ref<HTMLElement | null>(null);

function directoryName(server: ServerRecord) {
  return server.directory.split(/[\\/]/).filter(Boolean).at(-1) || server.id;
}

function focusInitialItem() {
  const initial = dialog.value?.querySelector<HTMLElement>(".instance-switcher-item.active")
    ?? dialog.value?.querySelector<HTMLElement>("button:not([disabled])");
  initial?.focus();
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = Array.from(dialog.value?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])
    .filter((element) => element.offsetParent !== null);
  if (!focusable.length) return;
  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
  const nextIndex = event.shiftKey
    ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
    : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
  event.preventDefault();
  focusable[nextIndex]?.focus();
}

watch(() => props.open, (open) => {
  if (open) void nextTick(focusInitialItem);
});
</script>

<template>
  <Transition name="modal" @after-leave="emit('after-leave')">
    <div v-if="props.open && props.servers.length" class="modal-backdrop instance-menu-backdrop" @click.self="emit('close')">
      <section ref="dialog" class="card instance-switcher" role="dialog" aria-modal="true" aria-labelledby="instance-switcher-title" tabindex="-1" @keydown="handleKeydown">
        <div class="card-header">
          <div><p class="eyebrow">Instances</p><h2 id="instance-switcher-title" class="card-title">切换服务端</h2></div>
          <button type="button" @click="emit('close')">关闭</button>
        </div>
        <div class="instance-switcher-list">
          <button v-for="server in props.servers" :key="server.id" type="button" class="instance-switcher-item" :class="{ active: server.id === props.selectedServerId }" @click="emit('select', server.id)">
            <span class="server-initial">{{ server.name.slice(0, 2).toUpperCase() }}</span>
            <span><strong>{{ server.name }}</strong><small class="muted">{{ props.statusText(server.status) }} · {{ directoryName(server) }}</small></span>
          </button>
        </div>
        <div class="row instance-switcher-actions">
          <button type="button" class="primary" @click="emit('create')">创建实例</button>
          <button v-if="props.selectedServer" type="button" class="danger" :disabled="props.selectedServer.status !== 'stopped' && props.selectedServer.status !== 'crashed'" @click="emit('delete', props.selectedServer)">删除当前实例</button>
        </div>
      </section>
    </div>
  </Transition>
</template>

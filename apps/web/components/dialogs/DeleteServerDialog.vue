<script setup lang="ts">
import type { ServerRecord } from "~/types/app";

const props = defineProps<{
  open: boolean;
  server: ServerRecord | null;
  confirmName: string;
  deleting: boolean;
  error: string;
  blocked: boolean;
  confirmationMatches: boolean;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [];
  "update:confirmName": [value: string];
}>();

const dialog = ref<HTMLElement | null>(null);
const confirmationInput = ref<HTMLInputElement | null>(null);

watch(() => props.open, (open) => {
  if (open) void nextTick(() => confirmationInput.value?.focus());
});

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && !props.deleting) {
    emit("close");
    return;
  }
  if (event.key !== "Tab" || !dialog.value) return;
  const focusable = [...dialog.value.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="props.open && props.server" class="modal-backdrop">
        <section ref="dialog" class="card delete-dialog stack" role="dialog" aria-modal="true" :aria-label="`删除服务端：${props.server.name}`" @keydown="handleKeydown">
        <div class="card-header">
          <div>
            <p class="eyebrow">Permanent Delete</p>
            <h2 class="card-title">删除服务端：{{ props.server.name }}</h2>
          </div>
          <span class="status-pill risk-high">包含文件</span>
        </div>
        <p class="message-content">这会删除服务端记录、控制台日志、Agent 对话、临时上传记录，以及磁盘上的完整服务端文件夹：</p>
        <code class="path-preview">{{ props.server.directory }}</code>
        <p v-if="props.blocked" class="danger-note">该服务端当前状态为 {{ props.server.status }}，必须先关闭到 stopped 或 crashed，且不能存在后台残留进程，才能删除。</p>
        <label class="stack">
          <span class="muted">请输入完整服务端名称以确认删除</span>
          <input ref="confirmationInput" :value="props.confirmName" :placeholder="props.server.name" autocomplete="off" @input="emit('update:confirmName', ($event.target as HTMLInputElement).value)" />
        </label>
        <p v-if="props.error" class="danger-note">删除失败：{{ props.error }}</p>
        <div class="row">
          <button class="danger" :disabled="props.deleting || props.blocked || !props.confirmationMatches" @click="emit('confirm')">
            {{ props.deleting ? "正在删除" : "永久删除" }}
          </button>
          <button :disabled="props.deleting" @click="emit('close')">取消</button>
        </div>
      </section>
    </div>
  </Transition>
</template>

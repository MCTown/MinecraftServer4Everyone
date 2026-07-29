<script setup lang="ts">
import type { AgentConfirmationRequest } from "~/types/app";

const props = defineProps<{
  confirmation: AgentConfirmationRequest | null;
}>();

const emit = defineEmits<{
  resolve: [approved: boolean];
}>();
</script>

<template>
  <Transition name="modal">
    <div v-if="props.confirmation" class="modal-backdrop">
      <section class="card confirmation-dialog stack">
        <div class="card-header">
          <h2 class="card-title">需要确认：{{ props.confirmation.title }}</h2>
          <span class="status-pill" :class="props.confirmation.risk === 'high' ? 'risk-high' : 'risk-medium'">{{ props.confirmation.risk }}</span>
        </div>
        <p class="message-content">{{ props.confirmation.description }}</p>
        <p class="muted">该操作会影响当前服务端目录以外的应用工作区、全局配置或数据库。确认后 Agent 才会继续执行。</p>
        <div class="row">
          <button class="primary" @click="emit('resolve', true)">确认执行</button>
          <button class="danger" @click="emit('resolve', false)">拒绝</button>
        </div>
      </section>
    </div>
  </Transition>
</template>

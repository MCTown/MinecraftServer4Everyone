<script setup lang="ts">
import type { ProxyTestResult } from "~/types/app";

const props = defineProps<{
  modeLabel: string;
  open: boolean;
  result: ProxyTestResult | null;
  resultText: (result: ProxyTestResult) => string;
  target: string;
  testing: boolean;
}>();

const emit = defineEmits<{
  close: [];
  test: [];
  "update:target": [value: string];
}>();
</script>

<template>
  <Transition name="modal">
    <div v-if="props.open" class="modal-backdrop">
      <form class="card stack proxy-test-dialog" @submit.prevent="emit('test')">
        <div class="card-header">
          <div>
            <p class="eyebrow">Proxy Probe</p>
            <h2 class="card-title">检测 Agent 代理连通性</h2>
          </div>
          <button type="button" :disabled="props.testing" @click="emit('close')">关闭</button>
        </div>
        <label class="stack">
          <span class="muted">检测地址</span>
          <input :value="props.target" placeholder="www.google.com" autocomplete="off" @input="emit('update:target', ($event.target as HTMLInputElement).value.trim())" />
        </label>
        <small class="muted">当前模式：{{ props.modeLabel }}。未写协议时会自动使用 https://。</small>
        <div v-if="props.result" class="proxy-test-result" :class="props.result.ok ? 'proxy-test-ok' : 'proxy-test-failed'">
          <strong>{{ props.result.ok ? "连通性确认通过" : "连通性确认失败" }}</strong>
          <span>{{ props.resultText(props.result) }}</span>
          <small>目标：{{ props.result.targetUrl }}</small>
          <small>最终地址：{{ props.result.finalUrl }}</small>
          <small>代理：{{ props.result.usedProxy ? "已使用" : "未使用" }}</small>
        </div>
        <div class="row proxy-test-actions">
          <button class="primary" type="submit" :disabled="props.testing || !props.target.trim()">{{ props.testing ? "检测中" : "确认检测" }}</button>
          <button type="button" :disabled="props.testing" @click="emit('close')">取消</button>
        </div>
      </form>
    </div>
  </Transition>
</template>

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

const dialog = useSettingsDialog(() => props.open, () => props.testing, () => emit('close'));
</script>

<template>
  <Transition name="modal">
    <div v-if="props.open" class="modal-backdrop settings-dialog-backdrop" @click.self="!props.testing && emit('close')">
      <form ref="dialog" class="card stack proxy-test-dialog settings-theme settings-dialog" role="dialog" aria-modal="true" aria-labelledby="proxy-test-title" tabindex="-1" @submit.prevent="emit('test')">
        <div class="card-header">
          <div>
            <p class="eyebrow">NETWORK DIAGNOSTICS</p>
            <h2 id="proxy-test-title" class="card-title">代理连通性检测</h2>
            <p class="settings-dialog-subtitle">通过 Agent 当前的网络配置，确认目标地址能否访问。</p>
          </div>
          <button type="button" class="settings-dialog-close" aria-label="关闭代理检测" :disabled="props.testing" @click="emit('close')"><AppIcon name="close" /></button>
        </div>
        <label class="settings-field">
          <span class="muted">检测地址</span>
          <input :value="props.target" placeholder="www.google.com" autocomplete="off" @input="emit('update:target', ($event.target as HTMLInputElement).value.trim())" />
        </label>
        <small class="muted">当前模式：{{ props.modeLabel }}。未写协议时会自动使用 https://。</small>
        <div v-if="props.result" class="proxy-test-result" :class="props.result.ok ? 'proxy-test-ok' : 'proxy-test-failed'" aria-live="polite">
          <strong><AppIcon :name="props.result.ok ? 'check' : 'warning'" />{{ props.result.ok ? "连接正常" : "连接失败" }}</strong>
          <span>{{ props.resultText(props.result) }}</span>
          <small>目标：{{ props.result.targetUrl }}</small>
          <small>最终地址：{{ props.result.finalUrl }}</small>
          <small>代理：{{ props.result.usedProxy ? "已使用" : "未使用" }}</small>
        </div>
        <div v-else class="settings-probe-empty" aria-live="polite"><AppIcon :name="props.testing ? 'loader' : 'network'" :spin="props.testing" /><span>{{ props.testing ? '正在建立连接，请稍候…' : '输入目标地址，开始一次网络检测。' }}</span></div>
        <div class="settings-dialog-actions">
          <button type="button" :disabled="props.testing" @click="emit('close')">取消</button>
          <button class="primary" type="submit" :disabled="props.testing || !props.target.trim()"><AppIcon :name="props.testing ? 'loader' : 'network'" :spin="props.testing" />{{ props.testing ? "检测中…" : props.result ? "重新检测" : "开始检测" }}</button>
        </div>
      </form>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import type { AgentToolConfigRequired, AgentToolSettings } from "~/types/app";

interface ProviderKeyForm {
  curseForgeApiKey: string;
  modrinthApiKey: string;
  braveSearchApiKey: string;
  tavilyApiKey: string;
  searxngBaseUrl: string;
}

const props = defineProps<{
  form: ProviderKeyForm;
  open: boolean;
  pendingConfig: AgentToolConfigRequired | null;
  placeholder: (key: "curseForgeApiKey" | "modrinthApiKey" | "braveSearchApiKey" | "tavilyApiKey") => string;
  saving: boolean;
  settings: AgentToolSettings;
}>();

const emit = defineEmits<{
  close: [];
  save: [];
  "update:curse-forge-api-key": [value: string];
  "update:modrinth-api-key": [value: string];
  "update:brave-search-api-key": [value: string];
  "update:tavily-api-key": [value: string];
  "update:searxng-base-url": [value: string];
}>();

const dialog = useSettingsDialog(() => props.open, () => props.saving, () => emit('close'));
</script>

<template>
  <Transition name="modal">
    <div v-if="props.open" class="modal-backdrop settings-dialog-backdrop" @click.self="!props.saving && emit('close')">
      <form ref="dialog" class="card stack provider-key-dialog settings-theme settings-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-key-title" tabindex="-1" @submit.prevent="emit('save')">
        <div class="card-header">
          <div>
            <p class="eyebrow">ACCESS & CREDENTIALS</p>
            <h2 id="provider-key-title" class="card-title">平台访问凭据</h2>
            <p class="settings-dialog-subtitle">为下载与搜索工具提供访问权限，密钥不会以明文回显。</p>
          </div>
          <button type="button" class="settings-dialog-close" aria-label="关闭凭据设置" :disabled="props.saving" @click="emit('close')"><AppIcon name="close" /></button>
        </div>
        <p v-if="props.pendingConfig" class="settings-warning-note"><AppIcon name="warning" />{{ props.pendingConfig.message }}</p>
        <div class="settings-section-label"><h2>内容平台</h2><span>整合包与模组下载</span></div>
        <div class="settings-field-grid">
          <label class="settings-field">
            <span class="muted">CurseForge API Key</span>
            <input :value="props.form.curseForgeApiKey" type="password" :placeholder="props.placeholder('curseForgeApiKey')" autocomplete="off" @input="emit('update:curse-forge-api-key', ($event.target as HTMLInputElement).value)" />
            <small class="muted">状态：{{ props.settings.curseForgeApiKeyConfigured ? "已配置" : "未配置" }} · <a href="https://console.curseforge.com/?#/api-keys" target="_blank" rel="noreferrer noopener">申请/管理</a></small>
          </label>
          <label class="settings-field">
            <span class="muted">Modrinth Personal Access Token</span>
            <input :value="props.form.modrinthApiKey" type="password" :placeholder="props.placeholder('modrinthApiKey')" autocomplete="off" @input="emit('update:modrinth-api-key', ($event.target as HTMLInputElement).value)" />
            <small class="muted">状态：{{ props.settings.modrinthApiKeyConfigured ? "已配置" : "未配置" }} · <a href="https://modrinth.com/settings/pats" target="_blank" rel="noreferrer noopener">申请/管理</a></small>
          </label>
        </div>
        <div class="settings-section-label"><h2>网页搜索</h2><span>可选配置</span></div>
        <div class="settings-field-grid">
          <label class="settings-field">
            <span class="muted">Brave Search API Key</span>
            <input :value="props.form.braveSearchApiKey" type="password" :placeholder="props.placeholder('braveSearchApiKey')" autocomplete="off" @input="emit('update:brave-search-api-key', ($event.target as HTMLInputElement).value)" />
            <small class="muted">状态：{{ props.settings.braveSearchApiKeyConfigured ? "已配置" : "未配置（使用免 Key 抓取）" }} · <a href="https://api-dashboard.search.brave.com/app/keys" target="_blank" rel="noreferrer noopener">申请/管理</a></small>
          </label>
          <label class="settings-field">
            <span class="muted">Tavily API Key</span>
            <input :value="props.form.tavilyApiKey" type="password" :placeholder="props.placeholder('tavilyApiKey')" autocomplete="off" @input="emit('update:tavily-api-key', ($event.target as HTMLInputElement).value)" />
            <small class="muted">状态：{{ props.settings.tavilyApiKeyConfigured ? "已配置" : "未配置（使用免 Key 抓取）" }} · <a href="https://app.tavily.com/home" target="_blank" rel="noreferrer noopener">申请/管理</a></small>
          </label>
          <label class="settings-field settings-field-wide">
            <span class="muted">SearXNG 实例地址</span>
            <input :value="props.form.searxngBaseUrl" type="url" placeholder="https://searxng.example.com" autocomplete="off" @input="emit('update:searxng-base-url', ($event.target as HTMLInputElement).value)" />
            <small class="muted">状态：{{ props.settings.searxngBaseUrl ? `已配置：${props.settings.searxngBaseUrl}` : "未配置（使用免 Key 抓取）" }}</small>
          </label>
        </div>
        <p class="settings-info-note"><AppIcon name="shield" /><span>密钥留空会保留原值。搜索按 Brave → Tavily → SearXNG → 免 Key 抓取的顺序尝试。</span></p>
        <div class="settings-dialog-actions">
          <button type="button" :disabled="props.saving" @click="emit('close')">取消</button>
          <button class="primary" type="submit" :disabled="props.saving"><AppIcon :name="props.saving ? 'loader' : 'check'" :spin="props.saving" />{{ props.saving ? "保存中…" : "保存凭据" }}</button>
        </div>
      </form>
    </div>
  </Transition>
</template>

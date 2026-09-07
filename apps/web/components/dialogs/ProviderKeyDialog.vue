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
</script>

<template>
  <Transition name="modal">
    <div v-if="props.open" class="modal-backdrop">
      <form class="card stack provider-key-dialog" @submit.prevent="emit('save')">
        <div class="card-header">
          <div>
            <p class="eyebrow">Provider Keys</p>
            <h2 class="card-title">配置平台 API Key</h2>
          </div>
          <button type="button" :disabled="props.saving" @click="emit('close')">关闭</button>
        </div>
        <p v-if="props.pendingConfig" class="danger-note">{{ props.pendingConfig.message }}</p>
        <div class="settings-field-grid">
          <label class="stack">
            <span class="muted">CurseForge API Key</span>
            <input :value="props.form.curseForgeApiKey" type="password" :placeholder="props.placeholder('curseForgeApiKey')" autocomplete="off" @input="emit('update:curse-forge-api-key', ($event.target as HTMLInputElement).value)" />
            <small class="muted">状态：{{ props.settings.curseForgeApiKeyConfigured ? "已配置" : "未配置" }} · <a href="https://console.curseforge.com/?#/api-keys" target="_blank" rel="noreferrer noopener">申请/管理</a></small>
          </label>
          <label class="stack">
            <span class="muted">Modrinth Personal Access Token</span>
            <input :value="props.form.modrinthApiKey" type="password" :placeholder="props.placeholder('modrinthApiKey')" autocomplete="off" @input="emit('update:modrinth-api-key', ($event.target as HTMLInputElement).value)" />
            <small class="muted">状态：{{ props.settings.modrinthApiKeyConfigured ? "已配置" : "未配置" }} · <a href="https://modrinth.com/settings/pats" target="_blank" rel="noreferrer noopener">申请/管理</a></small>
          </label>
          <label class="stack">
            <span class="muted">Brave Search API Key（网页搜索，可选）</span>
            <input :value="props.form.braveSearchApiKey" type="password" :placeholder="props.placeholder('braveSearchApiKey')" autocomplete="off" @input="emit('update:brave-search-api-key', ($event.target as HTMLInputElement).value)" />
            <small class="muted">状态：{{ props.settings.braveSearchApiKeyConfigured ? "已配置" : "未配置（使用免 Key 抓取）" }} · <a href="https://api-dashboard.search.brave.com/app/keys" target="_blank" rel="noreferrer noopener">申请/管理</a></small>
          </label>
          <label class="stack">
            <span class="muted">Tavily API Key（网页搜索，可选）</span>
            <input :value="props.form.tavilyApiKey" type="password" :placeholder="props.placeholder('tavilyApiKey')" autocomplete="off" @input="emit('update:tavily-api-key', ($event.target as HTMLInputElement).value)" />
            <small class="muted">状态：{{ props.settings.tavilyApiKeyConfigured ? "已配置" : "未配置（使用免 Key 抓取）" }} · <a href="https://app.tavily.com/home" target="_blank" rel="noreferrer noopener">申请/管理</a></small>
          </label>
          <label class="stack">
            <span class="muted">SearXNG 地址（网页搜索，可选）</span>
            <input :value="props.form.searxngBaseUrl" type="url" placeholder="https://searxng.example.com" autocomplete="off" @input="emit('update:searxng-base-url', ($event.target as HTMLInputElement).value)" />
            <small class="muted">状态：{{ props.settings.searxngBaseUrl ? `已配置：${props.settings.searxngBaseUrl}` : "未配置（使用免 Key 抓取）" }}</small>
          </label>
        </div>
        <small class="muted">留空会保留已保存的 Key；保存后只显示脱敏提示，不回显明文。搜索后端优先级：Brave → Tavily → SearXNG → 免 Key 抓取。</small>
        <div class="row">
          <button class="primary" type="submit" :disabled="props.saving">{{ props.saving ? "保存中" : "保存 Key" }}</button>
          <button type="button" :disabled="props.saving" @click="emit('close')">取消</button>
        </div>
      </form>
    </div>
  </Transition>
</template>

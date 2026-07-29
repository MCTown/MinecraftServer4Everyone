<script setup lang="ts">
import type { AgentToolConfigRequired, AgentToolSettings } from "~/types/app";

interface ProviderKeyForm {
  curseForgeApiKey: string;
  modrinthApiKey: string;
}

const props = defineProps<{
  form: ProviderKeyForm;
  open: boolean;
  pendingConfig: AgentToolConfigRequired | null;
  placeholder: (key: "curseForgeApiKey" | "modrinthApiKey") => string;
  saving: boolean;
  settings: AgentToolSettings;
}>();

const emit = defineEmits<{
  close: [];
  save: [];
  "update:curse-forge-api-key": [value: string];
  "update:modrinth-api-key": [value: string];
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
        </div>
        <small class="muted">留空会保留已保存的 Key；保存后只显示脱敏提示，不回显明文。</small>
        <div class="row">
          <button class="primary" type="submit" :disabled="props.saving">{{ props.saving ? "保存中" : "保存 Key" }}</button>
          <button type="button" :disabled="props.saving" @click="emit('close')">取消</button>
        </div>
      </form>
    </div>
  </Transition>
</template>

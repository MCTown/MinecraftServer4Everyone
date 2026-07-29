<script setup lang="ts">
import type { AgentToolRecord, AgentToolSettings, JavaDownloadSource, JavaDownloadSourceOption, JavaInstallTask, JavaInstallTaskStatus, JavaVersionRecord, ModelConfig, SkillRecord } from "~/types/app";
import type { SettingsNavItem, SettingsTab } from "~/types/ui";

interface ModelForm {
  apiKey: string;
  baseUrl: string;
  contextSizeK: number;
  displayName: string;
  isDefault: boolean;
  modelName: string;
}

const props = defineProps<{
  agentMemoryLabel: string;
  agentMemoryMb: number;
  agentMemoryWarning: boolean;
  autoConfirm: boolean;
  agentTools: AgentToolRecord[];
  apiKeyPlaceholder: string;
  fixedModelDisplayName: string;
  globalPrompt: string;
  hasUnsavedApiKey: boolean;
  javaDownloadSource: JavaDownloadSource;
  javaDownloadSources: JavaDownloadSourceOption[];
  javaVersionToInstall: string;
  javaVersions: JavaVersionRecord[];
  modelBusy: boolean;
  modelForm: ModelForm;
  modelSaving: boolean;
  modelTesting: boolean;
  providerKeySettings: AgentToolSettings;
  proxyEnabled: boolean;
  proxyUrl: string;
  selectedJavaBusy: boolean;
  selectedJavaInstalled: boolean;
  selectedJavaTask: JavaInstallTask | null;
  settingsNavItems: SettingsNavItem[];
  settingsTab: SettingsTab;
  skills: SkillRecord[];
  systemMemoryLabel: string;
  systemMemoryMb: number;
  toolConfigSummary: (tool: AgentToolRecord) => string;
  toolNeedsConfig: (tool: AgentToolRecord) => boolean;
  isJavaTaskActive: (status: JavaInstallTaskStatus) => boolean;
  isJavaTaskCancellable: (status: JavaInstallTaskStatus) => boolean;
  javaStatusClass: (java: JavaVersionRecord) => string;
  javaStatusText: (java: JavaVersionRecord) => string;
  javaTaskDetail: (task: JavaInstallTask) => string;
}>();

const emit = defineEmits<{
  "cancel-java": [version: string];
  "edit-prompt": [];
  "install-java": [version: string];
  "open-provider-keys": [];
  "open-proxy-test": [];
  refresh: [];
  "reset-prompt": [];
  "save-agent-settings": [];
  "save-model": [];
  "test-model": [];
  "toggle-skill": [skill: SkillRecord];
  "update:agent-memory-mb": [value: number];
  "update:auto-confirm": [value: boolean];
  "update:java-download-source": [value: JavaDownloadSource];
  "update:java-version-to-install": [value: string];
  "update:model-api-key": [value: string];
  "update:model-base-url": [value: string];
  "update:model-context-size-k": [value: number];
  "update:model-name": [value: string];
  "update:proxy-enabled": [value: boolean];
  "update:proxy-url": [value: string];
  "update:settings-tab": [value: SettingsTab];
}>();

function updateAgentMemory(event: Event) {
  emit("update:agent-memory-mb", Number((event.target as HTMLInputElement).value));
}
</script>

<template>
  <section class="settings-panel settings-docked">
    <nav class="settings-nav" aria-label="设置导航">
      <div class="settings-nav-header">
        <p class="eyebrow">Settings</p>
        <h2 class="card-title">平台配置</h2>
        <small class="muted">global · 影响所有实例</small>
      </div>
      <div class="settings-nav-list">
        <button v-for="item in props.settingsNavItems" :key="item.id" type="button" class="settings-nav-item" :class="{ active: props.settingsTab === item.id }" :aria-current="props.settingsTab === item.id ? 'page' : undefined" @click="emit('update:settings-tab', item.id)">
          <strong>{{ item.label }}</strong>
          <small>{{ item.desc }}</small>
        </button>
      </div>
      <div class="settings-nav-foot">
        <small>实例专属配置，例如 Java 路径、内存与启动指令，请在实例配置中修改。</small>
      </div>
    </nav>

    <div class="settings-content">
      <header class="settings-page-header">
        <div>
          <p class="settings-breadcrumb">SETTINGS / {{ props.settingsTab.toUpperCase() }}</p>
          <h1>{{ props.settingsNavItems.find((item) => item.id === props.settingsTab)?.label }}</h1>
        </div>
        <button type="button" class="settings-refresh" @click="emit('refresh')">刷新配置</button>
      </header>

      <div v-if="props.settingsTab === 'model'" class="settings-card settings-model-card">
        <div class="settings-section-heading">
          <p class="eyebrow">Single model · default_model</p>
          <h2 class="card-title">模型接入</h2>
          <p class="muted">平台只保留一条默认模型配置。请求会发送至 Base URL 下的 <code>/chat/completions</code>。</p>
        </div>
        <div class="settings-field-grid">
          <label class="settings-field"><span>显示名称</span><input :value="props.fixedModelDisplayName" readonly aria-readonly="true" /></label>
          <label class="settings-field"><span>模型名称</span><input :value="props.modelForm.modelName" class="mono-input" placeholder="gpt-4o-mini" @input="emit('update:model-name', ($event.target as HTMLInputElement).value)" /></label>
          <label class="settings-field settings-field-wide"><span>Base URL</span><input :value="props.modelForm.baseUrl" class="mono-input" placeholder="https://api.openai.com/v1" @input="emit('update:model-base-url', ($event.target as HTMLInputElement).value)" /><small>填写到 <code>/v1</code> 即可，不需要附加 <code>/chat/completions</code>。</small></label>
          <label class="settings-field"><span>上下文大小 (K)</span><input :value="props.modelForm.contextSizeK" type="number" min="8" max="2000" step="1" placeholder="120" @input="emit('update:model-context-size-k', Number(($event.target as HTMLInputElement).value))" /></label>
          <label class="settings-field"><span>API Key</span><input :value="props.modelForm.apiKey" :placeholder="props.apiKeyPlaceholder" type="password" autocomplete="off" @input="emit('update:model-api-key', ($event.target as HTMLInputElement).value)" /><small>只能覆盖写入，留空会保留当前已保存的 Key。</small></label>
        </div>
        <div class="settings-actions"><button :disabled="props.modelBusy || props.hasUnsavedApiKey" @click="emit('test-model')">{{ props.modelTesting ? "测试中" : "测试连通性" }}</button><button class="primary" :disabled="props.modelBusy" @click="emit('save-model')">{{ props.modelSaving ? "保存中" : "保存模型配置" }}</button></div>
      </div>

      <div v-else-if="props.settingsTab === 'skills'" class="settings-card settings-capability-card">
        <div class="settings-section-heading"><p class="eyebrow">skills 表</p><h2 class="card-title">Agent 技能</h2><p class="muted">技能决定 Agent 在部署过程中遵循哪些工作流。内容随版本发布，只有启用状态可调整。</p></div>
        <div v-if="props.skills.length === 0" class="settings-empty muted">暂无 Skills</div>
        <div v-else class="capability-grid">
          <article v-for="skill in props.skills" :key="skill.id" class="capability-card" :class="{ disabled: !skill.enabled }"><div class="capability-card-top"><div class="capability-card-title"><strong>{{ skill.name }}</strong><span class="status-pill" :class="skill.enabled ? 'status-running' : ''">{{ skill.enabled ? "已启用" : "已禁用" }}</span></div><span class="capability-meta">v{{ skill.version }}{{ skill.builtIn ? " · 内置" : "" }}</span></div><p class="capability-desc">{{ skill.description || "暂无描述" }}</p><div class="capability-card-actions"><button type="button" :class="{ primary: !skill.enabled }" @click="emit('toggle-skill', skill)">{{ skill.enabled ? "禁用 Skill" : "启用 Skill" }}</button></div></article>
        </div>
      </div>

      <div v-else-if="props.settingsTab === 'tools'" class="settings-card settings-capability-card">
        <div class="settings-section-heading"><p class="eyebrow">tool catalog</p><h2 class="card-title">工具与凭据</h2><p class="muted">工具本身始终可用。这里只处理它们需要的第三方凭据，缺失时部署会停在对应步骤。</p></div>
        <div v-if="props.agentTools.length === 0" class="settings-empty muted">暂无 Tools</div>
        <div v-else class="capability-grid">
          <article v-for="tool in props.agentTools" :key="tool.name" class="capability-card" :class="{ warning: props.toolNeedsConfig(tool) }"><div class="capability-card-top"><div class="capability-card-title"><strong>{{ tool.name }}</strong><span class="status-pill" :class="props.toolNeedsConfig(tool) ? 'risk-medium' : 'status-running'">{{ tool.category || "Tool" }}</span></div><span class="capability-meta">{{ props.toolConfigSummary(tool) }}</span></div><p class="capability-desc">{{ tool.description || "暂无描述" }}</p><div class="capability-card-actions"><button v-if="tool.configRequirements?.length" type="button" class="primary" @click="emit('open-provider-keys')">配置 API Key</button><small v-else class="muted">始终可用</small></div></article>
        </div>
      </div>

      <div v-else-if="props.settingsTab === 'agent'" class="settings-card settings-agent-card">
        <div class="settings-section-heading"><p class="eyebrow">app_settings</p><h2 class="card-title">Agent 行为</h2><p class="muted">配置 Agent 的确认方式、推荐内存、联网代理和所有实例默认继承的 System Prompt。</p></div>
        <div class="settings-agent-scroll">
          <div class="settings-agent-section stack"><div class="settings-agent-section-head"><div><h3>自动确认写操作</h3><p>开启后，修改配置、重启实例和删除文件不再逐次请求确认。</p></div><label class="settings-switch"><input :checked="props.autoConfirm" type="checkbox" @change="emit('update:auto-confirm', ($event.target as HTMLInputElement).checked)" /><span aria-hidden="true"></span></label></div><small v-if="props.autoConfirm" class="danger-note">自动确认已开启。Agent 可以在没有二次确认的情况下覆盖配置、重启实例或删除目录内文件。</small></div>
          <div class="settings-agent-section stack"><div class="settings-agent-section-head"><div><h3>Agent 默认内存</h3><p>仅影响 Agent 配置新服务端时使用的推荐内存，不会修改现有实例。</p></div><strong>{{ props.agentMemoryLabel }}</strong></div><input :value="props.agentMemoryMb" type="range" min="512" :max="props.systemMemoryMb" step="512" @change="updateAgentMemory" /><div class="settings-range-meta"><small>512 MB</small><small>设备最大内存 {{ props.systemMemoryLabel }}</small></div><small v-if="props.agentMemoryWarning" class="danger-note">当前设置超过设备内存的 90%，可能导致系统或服务端不稳定。</small><div class="settings-actions"><button type="button" @click="emit('save-agent-settings')">保存默认内存</button></div></div>
          <div class="settings-agent-section stack"><div class="settings-agent-section-head"><div><h3>下载代理</h3><p>影响 Agent 联网工具、Java 安装、Forge installer 和服务端进程，不影响模型请求。</p></div><label class="settings-switch"><input :checked="props.proxyEnabled" type="checkbox" @change="emit('update:proxy-enabled', ($event.target as HTMLInputElement).checked)" /><span aria-hidden="true"></span></label></div><div class="settings-proxy-controls"><input :value="props.proxyUrl" class="mono-input" placeholder="http://127.0.0.1:7890" :disabled="!props.proxyEnabled" @input="emit('update:proxy-url', ($event.target as HTMLInputElement).value)" @keyup.enter="emit('save-agent-settings')" /><button type="button" :disabled="props.proxyEnabled && !props.proxyUrl.trim()" @click="emit('save-agent-settings')">保存</button><button type="button" @click="emit('open-proxy-test')">检测</button></div><small class="muted">仅支持 HTTP/HTTPS 代理地址。</small></div>
          <div class="settings-agent-section stack"><div class="settings-agent-section-head"><div><h3>平台 API Key</h3><p>CurseForge 下载必需；Modrinth PAT 一般只在鉴权失败时需要。</p></div><button type="button" @click="emit('open-provider-keys')">配置凭据</button></div><div class="provider-key-summary"><small>CurseForge：{{ props.providerKeySettings.curseForgeApiKeyHint }}</small><small>Modrinth：{{ props.providerKeySettings.modrinthApiKeyHint }}</small></div></div>
          <div class="settings-agent-section settings-prompt-section stack"><div class="settings-agent-section-head"><div><h3>默认 System Prompt</h3><p>新实例默认继承；实例可使用自己的 Prompt 覆盖。</p></div><div class="settings-actions"><button type="button" @click="emit('reset-prompt')">恢复默认</button><button type="button" class="primary" @click="emit('edit-prompt')">修改 Prompt</button></div></div><pre class="settings-prompt-preview">{{ props.globalPrompt || "（空）" }}</pre></div>
        </div>
      </div>

      <div v-else class="settings-card settings-java-card">
        <div class="settings-section-heading"><p class="eyebrow">workspace/jdks</p><h2 class="card-title">Java 运行时</h2><p class="muted">平台不使用系统 Java。实例会从这里的受管 JDK 中选择版本。</p></div>
        <form class="row settings-java-controls" @submit.prevent="emit('install-java', props.javaVersionToInstall)">
          <select :value="props.javaVersionToInstall" class="compact-input" @change="emit('update:java-version-to-install', ($event.target as HTMLSelectElement).value)"><option v-for="java in props.javaVersions" :key="java.version" :value="java.version">{{ java.label }} - {{ props.javaStatusText(java) }}</option></select>
          <select :value="props.javaDownloadSource" class="compact-input" @change="emit('update:java-download-source', ($event.target as HTMLSelectElement).value as JavaDownloadSource)"><option v-for="source in props.javaDownloadSources" :key="source.id" :value="source.id">{{ source.label }}</option></select>
          <button class="primary" type="submit" :disabled="props.selectedJavaInstalled || props.selectedJavaBusy">{{ props.selectedJavaInstalled ? "已安装" : props.selectedJavaBusy ? "安装中" : "安装所选版本" }}</button>
          <button v-if="props.selectedJavaTask && props.isJavaTaskActive(props.selectedJavaTask.status)" class="danger" type="button" :disabled="!props.isJavaTaskCancellable(props.selectedJavaTask.status)" @click="emit('cancel-java', props.selectedJavaTask.version)">{{ props.selectedJavaTask.status === "cancelling" ? "取消中" : "取消安装" }}</button>
        </form>
        <div v-if="props.selectedJavaTask" class="java-progress stack"><div class="row"><span class="status-pill" :class="props.selectedJavaTask.status === 'failed' ? 'risk-high' : props.selectedJavaTask.status === 'installed' ? 'status-running' : props.isJavaTaskActive(props.selectedJavaTask.status) ? 'risk-medium' : ''">{{ props.selectedJavaTask.status }}</span><small class="muted">{{ props.javaTaskDetail(props.selectedJavaTask) }}</small></div><div v-if="props.isJavaTaskActive(props.selectedJavaTask.status)" class="progress-track"><span :style="{ width: `${props.selectedJavaTask.progress}%` }" /></div></div>
        <small class="settings-help">下拉框来自 Adoptium 可用主版本清单；默认使用国内高速源并自动回退官方源，安装中可随时取消，不会修改系统 Java。</small>
        <div class="java-version-list"><div v-for="java in props.javaVersions" :key="java.version" class="file-row java-version-row"><span>{{ java.label }} <span class="status-pill" :class="props.javaStatusClass(java)">{{ props.javaStatusText(java) }}</span><br /><small class="muted">{{ java.installPath || java.task?.message || "未安装到应用 workspace" }}</small><template v-if="java.task"><br /><small :class="java.task.status === 'failed' ? 'danger-note inline-note' : 'muted'">{{ props.javaTaskDetail(java.task) }}</small><div v-if="props.isJavaTaskActive(java.task.status)" class="progress-track"><span :style="{ width: `${java.task.progress}%` }" /></div></template></span><div class="row java-row-actions"><button v-if="java.task && props.isJavaTaskActive(java.task.status)" class="danger" type="button" :disabled="!props.isJavaTaskCancellable(java.task.status)" @click="emit('cancel-java', java.version)">{{ java.task.status === "cancelling" ? "取消中" : "取消" }}</button><button v-else-if="!java.installed" type="button" @click="emit('install-java', java.version)">安装</button></div></div></div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AgentToolRecord, AgentToolSettings, JavaDownloadSource, JavaDownloadSourceOption, JavaInstallTask, JavaInstallTaskStatus, JavaVersionRecord, ModelApiType, SkillRecord } from "~/types/app";
import type { SettingsNavItem, SettingsTab } from "~/types/ui";
import type { IconName } from "~/utils/icons";
import DeploymentWorkflowEditor from "~/components/settings/DeploymentWorkflowEditor.vue";

const navIcons: Record<SettingsTab, IconName> = {
  overview: "sliders", model: "cpu", workflow: "workflow", skills: "sparkles", tools: "tools", agent: "agent", java: "coffee"
};

interface ModelForm {
  apiKey: string;
  baseUrl: string;
  contextSizeK: number;
  displayName: string;
  isDefault: boolean;
  modelName: string;
  apiType: ModelApiType;
  availableModels: string[];
}

const props = defineProps<{
  loading: boolean;
  loaded: boolean;
  loadError: string;
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
  modelListBusy: boolean;
  modelSaving: boolean;
  modelTesting: boolean;
  providerKeySettings: AgentToolSettings;
  proxyEnabled: boolean;
  proxyUrl: string;
  pythonPackageIndexUrl: string;
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
  "list-models": [];
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
  "update:model-api-type": [value: ModelApiType];
  "update:model-base-url": [value: string];
  "update:model-context-size-k": [value: number];
  "update:model-name": [value: string];
  "update:proxy-enabled": [value: boolean];
  "update:proxy-url": [value: string];
  "update:python-package-index-url": [value: string];
  "update:settings-tab": [value: SettingsTab];
}>();

function updateAgentMemory(event: Event) {
  emit("update:agent-memory-mb", Number((event.target as HTMLInputElement).value));
}

const search = ref("");
const { theme, setTheme } = useTheme();
const content = ref<HTMLElement | null>(null);
const workflowEditor = ref<InstanceType<typeof DeploymentWorkflowEditor> | null>(null);
function refreshSettings() {
  emit("refresh");
  if (props.settingsTab === "workflow") void workflowEditor.value?.refresh();
}
const skillFilter = ref<"all" | "enabled" | "disabled">("all");
const currentPage = computed(() => props.settingsNavItems.find((item) => item.id === props.settingsTab));
const enabledSkills = computed(() => props.skills.filter((skill) => skill.enabled).length);
const installedJava = computed(() => props.javaVersions.filter((java) => java.installed).length);
const missingCredentials = computed(() => props.agentTools.filter(props.toolNeedsConfig).length);
const filteredSkills = computed(() => props.skills.filter((skill) => {
  const matchesState = skillFilter.value === "all" || skill.enabled === (skillFilter.value === "enabled");
  return matchesState && `${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(search.value.trim().toLowerCase());
}));
const filteredTools = computed(() => props.agentTools.filter((tool) => `${tool.name} ${tool.description ?? ""} ${tool.category ?? ""}`.toLowerCase().includes(search.value.trim().toLowerCase())));
const pageDescriptions: Record<SettingsTab, string> = {
  overview: "为你的工作空间，设定恰到好处的默认值。",
  model: "连接模型服务，为所有实例提供 AI 支持。",
  workflow: "让部署步骤井然有序，让 Agent 按你的流程行动。",
  skills: "选择 Agent 遵循的工作流，让每次部署更可靠。",
  tools: "了解 Agent 可用的工具，管理它们需要的访问凭据。",
  agent: "调整执行方式、资源偏好与网络连接。",
  java: "在一个地方管理 Minecraft 服务端需要的 Java 版本。"
};
const javaTaskLabels: Record<JavaInstallTaskStatus, string> = {
  pending: "等待安装", resolving: "解析下载源", downloading: "正在下载", extracting: "正在解压", installing: "正在安装", installed: "安装完成", failed: "安装失败", cancelled: "已取消", cancelling: "正在取消"
};
watch(() => props.settingsTab, async () => {
  search.value = "";
  skillFilter.value = "all";
  await nextTick();
  content.value?.scrollTo({ top: 0, behavior: "instant" });
  if (import.meta.client && window.matchMedia("(max-width: 820px)").matches) window.scrollTo({ top: 0, behavior: "instant" });
});
</script>

<template>
  <section class="settings-panel settings-docked settings-theme">
    <nav class="settings-nav" aria-label="设置导航">
      <div class="settings-nav-header">
        <span class="settings-brand-icon"><AppIcon name="settings" /></span>
        <div><h2>设置</h2><p>你的工作空间偏好</p></div>
      </div>
      <p class="settings-nav-caption">工作空间</p>
      <div class="settings-nav-list">
        <button v-for="item in props.settingsNavItems" :key="item.id" type="button" class="settings-nav-item" :class="{ active: props.settingsTab === item.id }" :aria-current="props.settingsTab === item.id ? 'page' : undefined" @click="emit('update:settings-tab', item.id)">
          <AppIcon :name="navIcons[item.id]" /><span>{{ item.label }}</span><AppIcon v-if="props.settingsTab === item.id" name="chevronRight" class="settings-nav-arrow" />
        </button>
      </div>
      <div class="settings-nav-foot">
        <AppIcon name="instances" /><strong>全局设置</strong>
        <small>这里的配置适用于所有实例。单个服务端的内存、启动指令等，请前往实例配置。</small>
      </div>
    </nav>

    <div ref="content" class="settings-content" :aria-busy="props.loading">
      <header class="settings-page-header">
        <div>
          <p class="settings-breadcrumb"><button type="button" @click="emit('update:settings-tab', 'overview')">设置</button><AppIcon name="chevronRight" /><span>{{ currentPage?.label }}</span></p>
          <h1>{{ currentPage?.label }}</h1>
          <p class="settings-page-description">{{ pageDescriptions[props.settingsTab] }}</p>
        </div>
        <button type="button" class="settings-refresh" :disabled="props.loading" @click="refreshSettings"><AppIcon name="refresh" :spin="props.loading" />{{ props.loading ? '刷新中…' : '刷新配置' }}</button>
      </header>

      <div :key="props.settingsTab" class="settings-page-body">
      <AsyncPlaceholder v-if="!props.loaded && props.loading" variant="form" label="正在加载工作空间设置" :rows="4" />
      <AsyncPlaceholder v-else-if="!props.loaded && props.loadError" :error="props.loadError" @retry="emit('refresh')" />
      <template v-else>
      <AsyncPlaceholder v-if="props.loadError" variant="compact" :error="props.loadError" @retry="emit('refresh')" />
      <div v-if="props.settingsTab === 'overview'" class="settings-overview">
        <section class="settings-welcome-card">
          <div><span class="settings-kicker">WORKSPACE SETTINGS</span><h2>让一切，按你的方式运行。</h2><p>从模型连接到运行环境，集中管理所有实例的基础配置。</p></div>
          <span class="settings-welcome-symbol" aria-hidden="true"><AppIcon name="sliders" :size="40" /></span>
        </section>
        <div class="settings-stats">
          <div><span>当前模型</span><strong class="settings-stat-model">{{ props.modelForm.modelName || '尚未设置' }}</strong><small>所有实例共享模型连接</small></div>
          <div><span>已启用技能</span><strong>{{ enabledSkills }} <small>/ {{ props.skills.length }}</small></strong><small>为 Agent 提供工作流指导</small></div>
          <div><span>已安装运行时</span><strong>{{ installedJava }} <small>个版本</small></strong><small>独立管理，不影响系统 Java</small></div>
        </div>
        <section class="settings-surface settings-appearance"><div><h2>显示模式</h2><p>默认使用暗色，选择会保存在当前浏览器，并应用到整个网站。</p></div><div class="settings-appearance-options" aria-label="显示模式"><button type="button" :aria-pressed="theme === 'dark'" @click="setTheme('dark')"><AppIcon name="moon" />暗色</button><button type="button" :aria-pressed="theme === 'light'" @click="setTheme('light')"><AppIcon name="sun" />亮色</button></div></section>
        <div class="settings-section-label"><h2>配置你的工作空间</h2><span>全局生效</span></div>
        <div class="settings-overview-grid">
          <button v-for="item in props.settingsNavItems.filter((item) => item.id !== 'overview')" :key="item.id" type="button" class="settings-overview-link" @click="emit('update:settings-tab', item.id)">
            <span class="settings-category-icon"><AppIcon :name="navIcons[item.id]" :size="22" /></span>
            <span class="settings-overview-copy"><strong>{{ item.label }}</strong><small>{{ item.desc }}</small><span class="settings-link-detail">{{ item.id === 'model' ? (props.modelForm.baseUrl ? '已填写连接地址' : '等待配置连接') : item.id === 'workflow' ? '可视化编排 · 实时 Prompt 预览' : item.id === 'skills' ? `${enabledSkills} 个技能已启用` : item.id === 'tools' ? (missingCredentials ? `${missingCredentials} 个工具需要凭据` : `${props.agentTools.length} 个工具可用`) : item.id === 'agent' ? (props.autoConfirm ? '自动确认已开启' : '写操作需手动确认') : `${installedJava} 个版本已安装` }}</span></span>
            <AppIcon name="arrowRight" class="settings-link-arrow" />
          </button>
        </div>
        <p class="settings-info-note"><AppIcon name="info" />实例专属设置不会被这里的默认配置覆盖，可在各实例的配置面板中单独调整。</p>
      </div>

      <div v-else-if="props.settingsTab === 'model'" class="settings-detail-layout">
        <div class="settings-detail-main">
          <section class="settings-surface">
            <div class="settings-surface-heading"><span class="settings-category-icon"><AppIcon name="network" /></span><div><h2>服务连接</h2><p>配置兼容 OpenAI 的模型服务接口。</p></div><span class="settings-badge">默认连接</span></div>
            <div class="settings-field-grid">
              <label class="settings-field"><span>显示名称</span><input :value="props.fixedModelDisplayName" readonly aria-readonly="true" /><small>平台统一使用一条默认模型配置。</small></label>
              <label class="settings-field"><span>接口格式</span><select :value="props.modelForm.apiType" @change="emit('update:model-api-type', ($event.target as HTMLSelectElement).value as ModelApiType)"><option value="chat_completions">Chat Completions</option><option value="responses">Responses</option></select><small>{{ props.modelForm.apiType === 'responses' ? '自动转换消息与工具定义，发送至 /responses。' : '请求发送至 /chat/completions。' }}</small></label>
              <label class="settings-field settings-field-wide"><span>Base URL</span><input :value="props.modelForm.baseUrl" class="mono-input" placeholder="https://api.openai.com/v1" @input="emit('update:model-base-url', ($event.target as HTMLInputElement).value)" /><small>填写到 <code>/v1</code> 即可，无需附加具体接口路径。</small></label>
              <label class="settings-field settings-field-wide"><span>API Key <span class="settings-field-hint">加密凭据</span></span><input :value="props.modelForm.apiKey" :placeholder="props.apiKeyPlaceholder" type="password" autocomplete="off" @input="emit('update:model-api-key', ($event.target as HTMLInputElement).value)" /><small>留空保留已保存的密钥；输入新值将覆盖原有密钥。</small></label>
            </div>
          </section>
          <section class="settings-surface">
            <div class="settings-surface-heading"><span class="settings-category-icon"><AppIcon name="cpu" /></span><div><h2>模型与上下文</h2><p>选择默认模型，并设置它的上下文容量。</p></div></div>
            <div class="settings-field-grid">
              <label class="settings-field settings-field-wide"><span>模型名称</span><div class="settings-input-action"><input :value="props.modelForm.modelName" class="mono-input" list="model-options" placeholder="gpt-4o-mini" @input="emit('update:model-name', ($event.target as HTMLInputElement).value)" /><button type="button" :disabled="props.modelListBusy || props.modelBusy" @click="emit('list-models')"><AppIcon :name="props.modelListBusy ? 'loader' : 'download'" :spin="props.modelListBusy" />{{ props.modelListBusy ? '拉取中…' : '拉取列表' }}</button></div><datalist id="model-options"><option v-for="model in props.modelForm.availableModels" :key="model" :value="model" /></datalist><small>可手动输入模型 ID，也可从上游拉取候选列表。</small></label>
              <label class="settings-field"><span>上下文容量 <span class="settings-field-hint">K tokens</span></span><input :value="props.modelForm.contextSizeK" type="number" min="8" max="2000" step="1" placeholder="120" @input="emit('update:model-context-size-k', Number(($event.target as HTMLInputElement).value))" /><small>请与模型实际支持的上下文大小保持一致。</small></label>
            </div>
            <div v-if="props.modelForm.availableModels.length" class="settings-model-options"><small>{{ props.modelForm.availableModels.length }} 个候选模型</small><div class="model-chip-row"><button v-for="model in props.modelForm.availableModels" :key="model" type="button" class="model-chip" :class="{ active: props.modelForm.modelName === model }" @click="emit('update:model-name', model)">{{ model }}</button></div></div>
          </section>
          <footer class="settings-save-bar"><span><AppIcon name="shield" />密钥保存后不会显示明文</span><div class="settings-actions"><button type="button" :disabled="props.modelBusy || props.hasUnsavedApiKey" :title="props.hasUnsavedApiKey ? '请先保存新密钥，再测试连接' : undefined" @click="emit('test-model')"><AppIcon :name="props.modelTesting ? 'loader' : 'network'" :spin="props.modelTesting" />{{ props.modelTesting ? '测试中…' : '测试连接' }}</button><button type="button" class="primary" :disabled="props.modelBusy" @click="emit('save-model')"><AppIcon :name="props.modelSaving ? 'loader' : 'check'" :spin="props.modelSaving" />{{ props.modelSaving ? '保存中…' : '保存配置' }}</button></div></footer>
          <p v-if="props.hasUnsavedApiKey" class="settings-info-note"><AppIcon name="info" />你输入了新的 API Key，请先保存配置，再测试连接。</p>
        </div>
        <aside class="settings-context-card"><AppIcon name="info" /><h3>一个连接，所有实例</h3><p>这里保存平台的默认模型连接。你仍然可以在对话中按会话切换模型。</p><hr /><h3>连接小提示</h3><p>Base URL 应包含服务商要求的版本路径。模型名称请使用服务商提供的准确 ID。</p><p>下载代理不影响模型请求。</p></aside>
      </div>

      <DeploymentWorkflowEditor v-else-if="props.settingsTab === 'workflow'" ref="workflowEditor" />

      <div v-else-if="props.settingsTab === 'skills'" class="settings-catalog">
        <div class="settings-catalog-toolbar"><div class="settings-filter-group" aria-label="筛选技能"><button v-for="filter in (['all', 'enabled', 'disabled'] as const)" :key="filter" type="button" :aria-pressed="skillFilter === filter" @click="skillFilter = filter">{{ filter === 'all' ? '全部技能' : filter === 'enabled' ? '已启用' : '已禁用' }}<span>{{ filter === 'all' ? props.skills.length : filter === 'enabled' ? enabledSkills : props.skills.length - enabledSkills }}</span></button></div><label class="settings-search"><AppIcon name="search" /><input v-model="search" type="search" placeholder="搜索技能…" aria-label="搜索技能" /></label></div>
        <p class="settings-info-note"><AppIcon name="info" />技能内容随版本发布。你可以调整启用状态，无需额外安装。</p>
        <div v-if="filteredSkills.length === 0" class="settings-empty"><AppIcon name="sparkles" :size="30" /><strong>{{ props.skills.length ? '没有找到匹配的技能' : '暂无可用技能' }}</strong><span>{{ props.skills.length ? '试试其他关键词或筛选条件。' : '技能会随平台版本更新提供。' }}</span><button v-if="props.skills.length" type="button" @click="search = ''; skillFilter = 'all'">清除筛选</button></div>
        <div v-else class="capability-grid">
          <article v-for="skill in filteredSkills" :key="skill.id" class="capability-card" :class="{ disabled: !skill.enabled }"><div class="capability-card-top"><span class="settings-category-icon"><AppIcon name="sparkles" /></span><span class="settings-badge">{{ skill.builtIn ? '内置技能' : '扩展技能' }}</span></div><h3>{{ skill.name }}</h3><p class="capability-desc">{{ skill.description || '暂无描述' }}</p><div class="capability-card-actions"><span class="capability-meta">v{{ skill.version }}</span><button type="button" class="settings-toggle-button" role="switch" :aria-checked="skill.enabled" :aria-label="`${skill.enabled ? '禁用' : '启用'} ${skill.name}`" @click="emit('toggle-skill', skill)"><span>{{ skill.enabled ? '已启用' : '已禁用' }}</span><span class="settings-toggle-track" :class="{ checked: skill.enabled }" aria-hidden="true" /></button></div></article>
        </div>
      </div>

      <div v-else-if="props.settingsTab === 'tools'" class="settings-catalog">
        <section class="settings-credentials-banner"><span class="settings-category-icon"><AppIcon name="key" :size="23" /></span><div><h2>第三方平台凭据</h2><p>{{ missingCredentials ? `${missingCredentials} 个工具需要补充凭据，相关部署步骤会等待配置。` : '工具始终可用。需要访问第三方平台时，使用这里保存的凭据。' }}</p></div><button type="button" @click="emit('open-provider-keys')">管理凭据<AppIcon name="arrowRight" /></button></section>
        <div class="settings-catalog-toolbar"><div class="settings-section-label"><h2>工具目录</h2><span>{{ props.agentTools.length }} 个工具</span></div><label class="settings-search"><AppIcon name="search" /><input v-model="search" type="search" placeholder="搜索名称、用途或分类…" aria-label="搜索工具" /></label></div>
        <div v-if="filteredTools.length === 0" class="settings-empty"><AppIcon name="tools" :size="30" /><strong>{{ props.agentTools.length ? '没有找到匹配的工具' : '暂无可用工具' }}</strong><span>工具目录随平台版本更新。</span><button v-if="search" type="button" @click="search = ''">清除搜索</button></div>
        <div v-else class="capability-grid">
          <article v-for="tool in filteredTools" :key="tool.name" class="capability-card" :class="{ warning: props.toolNeedsConfig(tool) }"><div class="capability-card-top"><span class="settings-category-icon"><AppIcon name="tools" /></span><span class="settings-badge">{{ tool.category || '通用工具' }}</span></div><h3 class="settings-tool-name">{{ tool.name }}</h3><p class="capability-desc">{{ tool.description || '暂无描述' }}</p><div class="capability-card-actions"><span class="settings-tool-state" :class="{ warning: props.toolNeedsConfig(tool) }"><AppIcon :name="props.toolNeedsConfig(tool) ? 'warning' : 'check'" />{{ props.toolConfigSummary(tool) }}</span><button v-if="tool.configRequirements?.length" type="button" class="settings-text-button" @click="emit('open-provider-keys')">配置<AppIcon name="chevronRight" /></button></div></article>
        </div>
      </div>

      <div v-else-if="props.settingsTab === 'agent'" class="settings-agent-layout">
        <section class="settings-surface"><div class="settings-surface-heading"><span class="settings-category-icon"><AppIcon name="shield" /></span><div><h2>执行与资源</h2><p>为自动化操作设定清晰的边界。</p></div></div>
          <div class="settings-preference-row"><div><h3 id="settings-auto-confirm-label">自动确认写操作</h3><p>修改配置、重启实例和删除文件时，不再逐次询问。</p><small>开关调整后自动保存</small></div><label class="settings-switch"><input :checked="props.autoConfirm" type="checkbox" role="switch" aria-labelledby="settings-auto-confirm-label" @change="emit('update:auto-confirm', ($event.target as HTMLInputElement).checked)" /><span aria-hidden="true" /></label></div>
          <p v-if="props.autoConfirm" class="settings-warning-note"><AppIcon name="warning" />自动确认已开启。Agent 可在没有二次确认的情况下覆盖配置、重启实例或删除文件。</p>
          <div class="settings-preference-row settings-memory-row"><div><h3>新实例推荐内存</h3><p>仅作为 Agent 配置新服务端时的默认建议，不修改现有实例。</p></div><strong class="settings-memory-value">{{ props.agentMemoryLabel }}</strong></div>
          <input :value="props.agentMemoryMb" aria-label="新实例推荐内存" type="range" min="512" :max="props.systemMemoryMb" step="512" @change="updateAgentMemory" /><div class="settings-range-meta"><small>512 MB</small><small>设备总内存 {{ props.systemMemoryLabel }}</small></div><p v-if="props.agentMemoryWarning" class="settings-warning-note"><AppIcon name="warning" />推荐值超过设备内存的 90%，可能影响系统稳定性。</p><div class="settings-actions"><button type="button" @click="emit('save-agent-settings')"><AppIcon name="check" />保存内存设置</button></div>
        </section>
        <section class="settings-surface"><div class="settings-surface-heading"><span class="settings-category-icon"><AppIcon name="network" /></span><div><h2>网络与下载</h2><p>让依赖获取和服务端联网更加顺畅。</p></div></div>
          <div class="settings-preference-row"><div><h3 id="settings-proxy-label">使用下载代理</h3><p>用于联网工具、Java 安装、Forge 安装器与服务端进程，不影响模型请求。</p><small>开关调整后自动保存</small></div><label class="settings-switch"><input :checked="props.proxyEnabled" type="checkbox" role="switch" aria-labelledby="settings-proxy-label" @change="emit('update:proxy-enabled', ($event.target as HTMLInputElement).checked)" /><span aria-hidden="true" /></label></div>
          <label class="settings-field"><span>代理地址</span><div class="settings-proxy-controls"><input :value="props.proxyUrl" class="mono-input" placeholder="http://127.0.0.1:7890" :disabled="!props.proxyEnabled" @input="emit('update:proxy-url', ($event.target as HTMLInputElement).value)" @keyup.enter="emit('save-agent-settings')" /><button type="button" :disabled="props.proxyEnabled && !props.proxyUrl.trim()" @click="emit('save-agent-settings')">保存</button><button type="button" @click="emit('open-proxy-test')"><AppIcon name="network" />检测</button></div><small>支持 HTTP / HTTPS 代理。</small></label>
          <label class="settings-field settings-separated-field"><span>Python 包镜像</span><div class="settings-proxy-controls"><input :value="props.pythonPackageIndexUrl" class="mono-input" placeholder="https://pypi.tuna.tsinghua.edu.cn/simple" @input="emit('update:python-package-index-url', ($event.target as HTMLInputElement).value)" @keyup.enter="emit('save-agent-settings')" /><button type="button" @click="emit('save-agent-settings')">保存</button></div><small>用于内置 Python 与 MCDReforged 依赖。填写 HTTP / HTTPS PyPI simple 地址，留空恢复默认镜像。</small></label>
        </section>
        <section class="settings-surface"><div class="settings-surface-heading"><span class="settings-category-icon"><AppIcon name="key" /></span><div><h2>平台凭据</h2><p>CurseForge 下载需要 API Key；其他平台按需配置。</p></div><button type="button" @click="emit('open-provider-keys')">管理凭据<AppIcon name="chevronRight" /></button></div><div class="provider-key-summary"><span><strong>CurseForge</strong><small>{{ props.providerKeySettings.curseForgeApiKeyHint }}</small></span><span><strong>Modrinth</strong><small>{{ props.providerKeySettings.modrinthApiKeyHint }}</small></span><span><strong>Brave Search</strong><small>{{ props.providerKeySettings.braveSearchApiKeyHint }}</small></span><span><strong>Tavily</strong><small>{{ props.providerKeySettings.tavilyApiKeyHint }}</small></span></div></section>
        <section class="settings-surface settings-prompt-section"><div class="settings-surface-heading"><span class="settings-category-icon"><AppIcon name="fileCode" /></span><div><h2>默认 System Prompt</h2><p>新实例默认继承，也可在实例中使用独立 Prompt。</p></div></div><pre class="settings-prompt-preview">{{ props.globalPrompt || '尚未配置提示词' }}</pre><div class="settings-actions"><button type="button" @click="emit('reset-prompt')"><AppIcon name="history" />恢复默认</button><button type="button" class="primary" @click="emit('edit-prompt')"><AppIcon name="edit" />编辑提示词</button></div></section>
      </div>

      <div v-else-if="props.settingsTab === 'java'" class="settings-java-layout">
        <section class="settings-surface"><div class="settings-surface-heading"><span class="settings-category-icon"><AppIcon name="download" /></span><div><h2>安装运行时</h2><p>选择 Java 版本和下载源，其余交给平台。</p></div></div>
          <form class="settings-java-controls" @submit.prevent="emit('install-java', props.javaVersionToInstall)"><label class="settings-field"><span>Java 版本</span><select :value="props.javaVersionToInstall" @change="emit('update:java-version-to-install', ($event.target as HTMLSelectElement).value)"><option v-for="java in props.javaVersions" :key="java.version" :value="java.version">{{ java.label }} · {{ props.javaStatusText(java) }}</option></select></label><label class="settings-field"><span>下载源</span><select :value="props.javaDownloadSource" @change="emit('update:java-download-source', ($event.target as HTMLSelectElement).value as JavaDownloadSource)"><option v-for="source in props.javaDownloadSources" :key="source.id" :value="source.id">{{ source.label }}</option></select></label><button class="primary" type="submit" :disabled="!props.javaVersionToInstall || props.selectedJavaInstalled || props.selectedJavaBusy"><AppIcon :name="props.selectedJavaBusy ? 'loader' : props.selectedJavaInstalled ? 'check' : 'download'" :spin="props.selectedJavaBusy" />{{ props.selectedJavaInstalled ? '已安装' : props.selectedJavaBusy ? '安装中…' : '安装运行时' }}</button><button v-if="props.selectedJavaTask && props.isJavaTaskActive(props.selectedJavaTask.status)" class="danger" type="button" :disabled="!props.isJavaTaskCancellable(props.selectedJavaTask.status)" @click="emit('cancel-java', props.selectedJavaTask.version)">{{ props.selectedJavaTask.status === 'cancelling' ? '取消中…' : '取消安装' }}</button></form>
          <div v-if="props.selectedJavaTask" class="java-progress" aria-live="polite"><div class="row"><span class="status-pill" :class="props.selectedJavaTask.status === 'failed' ? 'risk-high' : props.selectedJavaTask.status === 'installed' ? 'status-running' : props.isJavaTaskActive(props.selectedJavaTask.status) ? 'risk-medium' : ''">{{ javaTaskLabels[props.selectedJavaTask.status] }}</span><small>{{ props.javaTaskDetail(props.selectedJavaTask) }}</small></div><div v-if="props.isJavaTaskActive(props.selectedJavaTask.status)" class="progress-track" role="progressbar" aria-label="Java 安装进度" :aria-valuenow="props.selectedJavaTask.progress" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${props.selectedJavaTask.progress}%` }" /></div></div>
          <p class="settings-info-note"><AppIcon name="info" />默认使用国内高速源，自动回退官方源。安装过程可取消，不会修改系统 Java。</p>
        </section>
        <section class="settings-surface settings-runtime-surface"><div class="settings-surface-heading"><span class="settings-category-icon"><AppIcon name="coffee" /></span><div><h2>运行时目录</h2><p>在实例配置中选择这里已安装的受管 JDK。</p></div><span class="settings-badge">{{ installedJava }} 个已安装</span></div>
          <div v-if="!props.javaVersions.length" class="settings-empty"><AppIcon name="coffee" :size="30" /><strong>暂时没有可用版本</strong><span>刷新配置以重新获取版本清单。</span></div>
          <div v-else class="java-version-list"><article v-for="java in props.javaVersions" :key="java.version" class="java-version-row"><span class="settings-java-avatar"><AppIcon name="coffee" /></span><div class="settings-java-copy"><div><h3>{{ java.label }}</h3><span class="status-pill" :class="props.javaStatusClass(java)">{{ props.javaStatusText(java) }}</span></div><p class="mono-input">{{ java.installPath || java.task?.message || '尚未安装到工作空间' }}</p><template v-if="java.task"><small :class="{ 'settings-task-error': java.task.status === 'failed' }">{{ props.javaTaskDetail(java.task) }}</small><div v-if="props.isJavaTaskActive(java.task.status)" class="progress-track" role="progressbar" :aria-label="`${java.label} 安装进度`" :aria-valuenow="java.task.progress" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${java.task.progress}%` }" /></div></template></div><div class="java-row-actions"><button v-if="java.task && props.isJavaTaskActive(java.task.status)" class="danger" type="button" :disabled="!props.isJavaTaskCancellable(java.task.status)" @click="emit('cancel-java', java.version)">{{ java.task.status === 'cancelling' ? '取消中…' : '取消' }}</button><button v-else-if="!java.installed" type="button" @click="emit('install-java', java.version)"><AppIcon name="download" />安装</button><span v-else class="settings-installed"><AppIcon name="check" />就绪</span></div></article></div>
        </section>
      </div>
      </template>
      </div>
    </div>
  </section>
</template>

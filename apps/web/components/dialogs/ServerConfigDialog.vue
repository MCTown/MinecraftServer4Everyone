<script setup lang="ts">
import type { ServerConfigForm } from "~/types/ui";

interface JavaVersionOption {
  installed: boolean;
  label: string;
  version: string;
}

const props = defineProps<{
  form: ServerConfigForm;
  javaVersions: JavaVersionOption[];
  memoryLabel: string;
  memoryMaxMb: number;
  memoryMb: number;
  memoryWarning: boolean;
  minimumMemoryMb: number;
  systemMemoryLabel: string;
  formatMemory: (valueMb: number) => string;
}>();

const emit = defineEmits<{
  close: [];
  "select-java": [];
  save: [];
  "update:memory-mb": [value: number];
}>();

function updateMemory(event: Event) {
  emit("update:memory-mb", Number((event.target as HTMLInputElement).value));
}
</script>

<template>
  <form class="card stack management-dialog config-dialog" @submit.prevent="emit('save')">
    <div class="card-header">
      <div><p class="eyebrow">Instance Config</p><h2 class="card-title">服务端配置</h2></div>
      <div class="row"><button class="primary" type="submit">保存</button><button type="button" @click="emit('close')">关闭</button></div>
    </div>
    <label class="config-field stack"><span class="muted">服务端名字</span><input v-model.trim="props.form.name" placeholder="服务端名字" /></label>
    <label class="config-field stack">
      <span class="muted">使用内存大小</span>
      <div class="memory-config-panel">
        <div class="memory-config-head"><strong>{{ props.memoryLabel }}</strong><input :value="props.memoryMb" type="number" :min="props.minimumMemoryMb" :max="props.memoryMaxMb" step="512" inputmode="numeric" @input="updateMemory" /></div>
        <input :value="props.memoryMb" class="memory-slider" type="range" :min="props.minimumMemoryMb" :max="props.memoryMaxMb" step="512" @input="updateMemory" />
        <div class="row memory-range-labels"><small class="muted">{{ props.formatMemory(props.minimumMemoryMb) }}</small><small class="muted">设备最大内存 {{ props.systemMemoryLabel }}</small></div>
        <small v-if="props.memoryWarning" class="danger-note">当前设置超过设备内存的 90%，可能导致系统或服务端不稳定。</small>
      </div>
    </label>
    <label class="config-field stack"><span class="muted">使用 Java 版本</span><select v-model="props.form.javaVersion" @change="emit('select-java')"><option v-for="java in props.javaVersions" :key="java.version" :value="java.version">{{ java.label }}{{ java.installed ? "（已安装）" : "" }}</option></select></label>
    <label class="config-field stack"><span class="muted">Java 可执行文件路径</span><input v-model.trim="props.form.javaPath" placeholder="留空则按所选 Java 版本自动解析" /></label>
    <label class="config-field stack"><span class="muted">服务端 Jar 文件</span><input v-model.trim="props.form.jarFile" placeholder="server.jar" /></label>
    <label class="config-field stack"><span class="muted">启动附加参数</span><input v-model.trim="props.form.startArgs" placeholder="nogui" /></label>
    <label class="config-field stack"><span class="muted">Minecraft 版本</span><input v-model.trim="props.form.minecraftVersion" placeholder="例如 1.21.4" /></label>
    <label class="config-field stack"><span class="muted">整合包名称</span><input v-model.trim="props.form.modpackName" placeholder="可选" /></label>
    <label class="config-field stack"><span class="muted">启动指令</span><textarea v-model.trim="props.form.startupCommand" class="startup-command-input" placeholder="留空则自动使用服务端脚本或 Jar。可用变量：{java} {javaHome} {memory} {minMemory} {maxMemory} {jarFile} {startArgs}" /></label>
    <label class="config-field config-prompt-toggle"><input v-model="props.form.useGlobalPrompt" type="checkbox" /><span>使用全局 Agent Prompt</span></label>
    <label class="config-field stack"><span class="muted">实例 Agent Prompt 覆盖</span><textarea v-model.trim="props.form.promptOverride" :disabled="props.form.useGlobalPrompt" placeholder="关闭全局 Prompt 后可为当前实例单独设置" /></label>
  </form>
</template>

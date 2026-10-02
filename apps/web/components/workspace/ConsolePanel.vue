<script setup lang="ts">
import type { ConsoleLogEntry, ServerErrorState } from "~/types/app";
import type { RenderedConsoleLogEntry } from "~/utils/consoleRendering";

const props = defineProps<{
  analyzing: boolean;
  refreshing: boolean;
  loading: boolean;
  loadError: string;
  command: string;
  commandHistory: string[];
  errorState: ServerErrorState | null;
  hasError: boolean;
  logs: ConsoleLogEntry[];
  renderedLogs: RenderedConsoleLogEntry[];
}>();

const emit = defineEmits<{
  analyze: [];
  refresh: [];
  send: [];
  "update:command": [value: string];
}>();

const analyzeTitle = computed(() => {
  if (!props.hasError) return "";
  const state = props.errorState;
  const level = state?.level === "fatal" ? "致命错误" : "错误";
  const detail = state?.latestText ? `\n最近一条：${state.latestText}` : "";
  return `让 Agent 分析 ${state?.count || 1} 条${level}${detail}`;
});

const commandHistoryStatus = computed(() => {
  const count = props.commandHistory.length;
  if (count === 0) return "暂无历史命令";
  if (historyIndex.value === -1) return `历史命令 ${count} 条 · 上下键浏览 · 右方向键补全`;
  return `正在查看历史命令 ${historyIndex.value + 1}/${count} · 下方向键返回草稿`;
});

const panel = ref<HTMLElement | null>(null);
const logList = ref<HTMLElement | null>(null);
const historyIndex = ref(-1);
let commandDraft = "";

watch(() => props.commandHistory, () => {
  historyIndex.value = -1;
  commandDraft = "";
});

function updateCommand(value: string) {
  historyIndex.value = -1;
  emit("update:command", value);
}

function useHistoryCommand(command: string) {
  emit("update:command", command);
}

function handleCommandKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowUp") {
    if (props.commandHistory.length === 0) return;
    event.preventDefault();
    if (historyIndex.value === -1) commandDraft = props.command;
    historyIndex.value = Math.min(historyIndex.value + 1, props.commandHistory.length - 1);
    useHistoryCommand(props.commandHistory.at(-(historyIndex.value + 1)) ?? "");
    return;
  }

  if (event.key === "ArrowDown") {
    if (historyIndex.value === -1) return;
    event.preventDefault();
    historyIndex.value -= 1;
    useHistoryCommand(historyIndex.value === -1 ? commandDraft : props.commandHistory.at(-(historyIndex.value + 1)) ?? "");
    return;
  }

  if (event.key !== "ArrowRight") return;
  const input = event.currentTarget as HTMLInputElement;
  if (input.selectionStart !== props.command.length || input.selectionEnd !== props.command.length || !props.command) return;
  const completion = [...props.commandHistory].reverse().find((command) => command !== props.command && command.startsWith(props.command));
  if (!completion) return;
  event.preventDefault();
  historyIndex.value = -1;
  useHistoryCommand(completion);
}

function focusPanel() {
  panel.value?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  panel.value?.focus({ preventScroll: true });
}

function getLogList() {
  return logList.value;
}

defineExpose({ focusPanel, getLogList });
</script>

<template>
  <section ref="panel" tabindex="-1" class="card stack workspace-card console-card single-console-panel">
    <header class="card-header console-toolbar">
      <div class="console-toolbar-heading">
        <h2 class="card-title icon-heading"><AppIcon name="terminal" :size="16" />终端</h2>
        <span v-if="props.hasError" class="console-error-count" :title="analyzeTitle">{{ props.errorState?.count || 1 }} 条{{ props.errorState?.level === 'fatal' ? '致命错误' : '错误' }}</span>
      </div>
      <div class="console-toolbar-actions" role="group" aria-label="终端操作">
        <button
          v-if="props.hasError"
          class="console-analyze"
          type="button"
          :disabled="props.analyzing"
          :title="analyzeTitle"
          :aria-label="props.analyzing ? '正在分析错误' : '让 Agent 分析错误'"
          :aria-busy="props.analyzing"
          @click="emit('analyze')"
        >
          <AppIcon :name="props.analyzing ? 'loader' : 'sparkles'" :size="14" :spin="props.analyzing" />
          {{ props.analyzing ? "分析中…" : "Agent 分析" }}
        </button>
        <span v-if="props.hasError" class="console-toolbar-divider" aria-hidden="true" />
        <button class="console-refresh" type="button" :disabled="props.refreshing || props.loading" :title="props.refreshing || props.loading ? '正在刷新日志' : '刷新日志'" :aria-label="props.refreshing || props.loading ? '正在刷新日志' : '刷新日志'" :aria-busy="props.refreshing || props.loading" @click="emit('refresh')"><AppIcon name="refresh" :size="16" :spin="props.refreshing || props.loading" /></button>
      </div>
    </header>
    <div ref="logList" class="console" :aria-busy="props.loading || props.refreshing">
      <AsyncPlaceholder v-if="props.loading" label="正在加载终端日志" :rows="5" />
      <AsyncPlaceholder v-else-if="props.loadError" variant="compact" :error="props.loadError" @retry="emit('refresh')" />
      <p v-else-if="props.logs.length === 0" class="console-empty">暂无日志，启动实例后会显示实时输出。</p>
      <div v-for="log in props.renderedLogs" :key="log.id" :class="['console-entry', log.stream]" v-html="log.html" />
    </div>
    <form class="row command-bar" @submit.prevent="emit('send')">
      <input :value="props.command" placeholder="输入服务端控制台指令" @input="updateCommand(($event.target as HTMLInputElement).value)" @keydown="handleCommandKeydown" />
      <button class="primary" type="submit"><AppIcon name="send" />发送</button>
    </form>
    <p class="command-history-status" role="status">{{ commandHistoryStatus }}</p>
  </section>
</template>

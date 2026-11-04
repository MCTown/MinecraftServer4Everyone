<script setup lang="ts">
import type { AgentQuestionRequest } from "~/types/app";
import { readNodeBrowserState, writeBrowserState } from "~/utils/browserState";

const props = defineProps<{ scopeId: string }>();
const { api, nodeId, stateKey } = useApi();
const question = ref<AgentQuestionRequest | null>(null);
const selected = ref<string[]>([]);
const submitting = ref(false);
const error = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let mounted = false;
const endpoint = (scope: string) => scope === "global" ? "/api/agent/question" : `/api/servers/${encodeURIComponent(scope)}/agent/question`;

async function poll(current: number) {
  const scope = props.scopeId;
  try {
    if (scope) {
      const result = await api<{ question: AgentQuestionRequest | null }>(endpoint(scope));
      if (current !== generation) return;
      if (result.question?.id !== question.value?.id) {
        const saved = readNodeBrowserState<{ id: string; selected: string[] }>(nodeId, `question:${scope}`);
        question.value = result.question;
        selected.value = saved && saved.id === result.question?.id
          ? saved.selected.filter((label) => result.question!.options.some((option) => option.label === label)) : [];
        error.value = "";
      }
      question.value = result.question;
    }
  } catch {
    // Transient disconnections must not discard a user's current selection.
  } finally {
    if (mounted && current === generation) timer = setTimeout(() => void poll(current), 1000);
  }
}

function restart() {
  generation++;
  clearTimeout(timer);
  question.value = null;
  selected.value = [];
  error.value = "";
  if (mounted) void poll(generation);
}

watch(() => props.scopeId, restart);
watch(selected, (value) => {
  if (question.value) writeBrowserState(stateKey(`question:${props.scopeId}`), { id: question.value.id, selected: value });
}, { deep: true, flush: "sync" });
onMounted(() => { mounted = true; restart(); });
onBeforeUnmount(() => { mounted = false; generation++; clearTimeout(timer); });

async function submit(cancelled = false) {
  if (!question.value || submitting.value) return;
  const current = generation;
  const id = question.value.id;
  submitting.value = true;
  error.value = "";
  try {
    await api(endpoint(props.scopeId), { method: "POST", body: { questionId: id, selected: selected.value, cancelled } });
    writeBrowserState(stateKey(`question:${props.scopeId}`), null);
    if (current === generation && question.value?.id === id) question.value = null;
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : "提交失败，请重试";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="question" class="modal-backdrop">
      <section class="card confirmation-dialog stack question-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-question-title" :aria-busy="submitting">
        <h2 id="agent-question-title" class="card-title">Agent 需要你的选择</h2>
        <form class="stack" @submit.prevent="submit()">
          <fieldset class="question-options stack" :disabled="submitting">
            <legend class="message-content">{{ question.question }}</legend>
            <p class="muted">{{ question.multiple ? '可多选，至少选择一项' : '请选择一项' }}</p>
            <label v-for="(option, index) in question.options" :key="option.label" class="question-option" :class="{ chosen: selected.includes(option.label) }">
              <input v-if="question.multiple" v-model="selected" type="checkbox" :value="option.label" />
              <input v-else type="radio" name="agent-question-choice" :value="option.label" :checked="selected.includes(option.label)" @change="selected = [option.label]" />
              <span><strong>{{ index + 1 }}. {{ option.label }}</strong><small v-if="option.description" class="muted">{{ option.description }}</small></span>
            </label>
          </fieldset>
          <p v-if="error" role="alert">{{ error }}</p>
          <div class="row">
            <button class="primary" type="submit" :disabled="submitting || !selected.length">{{ submitting ? '正在提交…' : '提交选择' }}</button>
            <button type="button" :disabled="submitting" @click="submit(true)">取消选择</button>
          </div>
        </form>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.question-dialog { max-height: 85dvh; overflow-y: auto; }
.question-options { border: 0; padding: 0; margin: 0; min-width: 0; }
.question-options legend { padding: 0; margin-bottom: 12px; }
.question-option { display: flex; align-items: flex-start; gap: 12px; padding: 14px; border-radius: 8px; background: var(--surface-soft); cursor: pointer; }
.question-option.chosen { outline: 2px solid var(--accent); outline-offset: -2px; }
.question-option input { flex: 0 0 auto; width: auto; margin-top: 4px; }
.question-option span { min-width: 0; overflow-wrap: anywhere; }
.question-option small { display: block; margin-top: 4px; white-space: pre-wrap; }
</style>

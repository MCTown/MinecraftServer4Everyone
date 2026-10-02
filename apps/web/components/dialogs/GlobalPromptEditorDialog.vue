<script setup lang="ts">
import CodeEditor from "~/components/CodeEditor.vue";

const props = defineProps<{
  draft: string;
  open: boolean;
  saving: boolean;
}>();

const emit = defineEmits<{
  close: [];
  save: [];
  "update:draft": [value: string];
}>();

const dialog = useSettingsDialog(() => props.open, () => props.saving, () => emit('close'));
</script>

<template>
  <Transition name="modal">
    <div v-if="props.open" class="modal-backdrop settings-dialog-backdrop" @click.self="!props.saving && emit('close')">
      <section ref="dialog" class="card stack editor-dialog prompt-editor-dialog settings-theme settings-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-editor-title" tabindex="-1">
        <div class="card-header"><div><p class="eyebrow">AGENT INSTRUCTIONS</p><h2 id="prompt-editor-title" class="card-title">编辑默认提示词</h2><p class="settings-dialog-subtitle">设定 Agent 的角色、工作方式与操作边界。新实例默认继承此提示词。</p></div><button type="button" class="settings-dialog-close" aria-label="关闭提示词编辑器" :disabled="props.saving" @click="emit('close')"><AppIcon name="close" /></button></div>
        <div class="code-editor"><CodeEditor :model-value="props.draft" :readonly="props.saving" @update:model-value="emit('update:draft', $event)" /></div>
        <div class="settings-editor-meta"><span>Markdown · 支持撤销与重做</span><span>{{ props.draft.length.toLocaleString() }} 字符</span></div>
        <div class="settings-dialog-actions">
          <button type="button" :disabled="props.saving" @click="emit('close')">取消</button>
          <button type="button" class="primary" :disabled="props.saving" @click="emit('save')"><AppIcon :name="props.saving ? 'loader' : 'check'" :spin="props.saving" />{{ props.saving ? "保存中…" : "保存提示词" }}</button>
        </div>
      </section>
    </div>
  </Transition>
</template>

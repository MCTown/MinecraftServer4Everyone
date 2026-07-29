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
</script>

<template>
  <Transition name="modal">
    <div v-if="props.open" class="modal-backdrop" @click.self="emit('close')">
      <section class="card stack editor-dialog prompt-editor-dialog">
        <div class="card-header"><h2 class="card-title">编辑全局 Prompt</h2><button type="button" :disabled="props.saving" @click="emit('close')">关闭</button></div>
        <div class="code-editor"><CodeEditor :model-value="props.draft" @update:model-value="emit('update:draft', $event)" /></div>
        <div class="row prompt-editor-actions">
          <button type="button" :disabled="props.saving" @click="emit('close')">取消</button>
          <button type="button" class="primary" :disabled="props.saving" @click="emit('save')">{{ props.saving ? "保存中…" : "保存" }}</button>
        </div>
      </section>
    </div>
  </Transition>
</template>

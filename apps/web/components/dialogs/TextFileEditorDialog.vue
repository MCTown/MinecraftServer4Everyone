<script setup lang="ts">
import CodeEditor from "~/components/CodeEditor.vue";

const props = defineProps<{
  content: string;
  open: boolean;
  path: string;
}>();

const emit = defineEmits<{
  close: [];
  save: [];
  "update:content": [value: string];
}>();
</script>

<template>
  <Transition name="modal">
    <div v-if="props.open" class="modal-backdrop">
      <section class="card stack editor-dialog">
        <div class="card-header"><h2 class="card-title">编辑 {{ props.path }}</h2><button type="button" @click="emit('close')">关闭</button></div>
        <div class="code-editor"><CodeEditor :model-value="props.content" @update:model-value="emit('update:content', $event)" /></div>
        <button class="primary" type="button" @click="emit('save')">保存文件</button>
      </section>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import CodeEditor from "~/components/CodeEditor.vue";

const props = defineProps<{
  content: string;
  loading: boolean;
  loadError: string;
  open: boolean;
  path: string;
}>();

const emit = defineEmits<{
  close: [];
  save: [];
  retry: [];
  "update:content": [value: string];
}>();
</script>

<template>
  <Transition name="modal">
    <div v-if="props.open" class="modal-backdrop">
      <section class="card stack editor-dialog">
        <div class="card-header"><h2 class="card-title">编辑 {{ props.path }}</h2><button type="button" @click="emit('close')"><AppIcon name="close" />关闭</button></div>
        <AsyncPlaceholder v-if="props.loading" variant="editor" label="正在读取文件内容" :rows="5" />
        <AsyncPlaceholder v-else-if="props.loadError" variant="editor" :error="props.loadError" @retry="emit('retry')" />
        <div v-else class="code-editor"><CodeEditor :model-value="props.content" @update:model-value="emit('update:content', $event)" /></div>
        <button class="primary" type="button" :disabled="props.loading || Boolean(props.loadError)" @click="emit('save')"><AppIcon name="save" />保存文件</button>
      </section>
    </div>
  </Transition>
</template>

<script setup lang="ts">
const props = defineProps<{
  open: boolean;
  name: string;
}>();

const emit = defineEmits<{
  close: [];
  create: [];
  "update:name": [value: string];
}>();
</script>

<template>
  <Transition name="modal">
    <div v-if="props.open" class="modal-backdrop">
      <form class="card create-dialog stack" @submit.prevent="emit('create')">
        <div>
          <p class="eyebrow">Create Instance</p>
          <h2 class="card-title">新建实例</h2>
        </div>
        <label class="stack">
          <span class="muted">请输入服务端名称</span>
          <input :value="props.name" placeholder="例如：Survival-01" autocomplete="off" autofocus @input="emit('update:name', ($event.target as HTMLInputElement).value)" />
        </label>
        <div class="row">
          <button class="primary" type="submit" :disabled="!props.name.trim()">创建并进入控制台</button>
          <button type="button" @click="emit('close')">取消</button>
        </div>
      </form>
    </div>
  </Transition>
</template>

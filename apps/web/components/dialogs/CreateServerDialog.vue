<script setup lang="ts">
const props = defineProps<{
  open: boolean;
  name: string;
  creating: boolean;
  error: string;
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
      <form class="card create-dialog stack" :aria-busy="props.creating" @submit.prevent="!props.creating && props.name.trim() && emit('create')">
        <div>
          <p class="eyebrow">Create Instance</p>
          <h2 class="card-title">新建实例</h2>
        </div>
        <label class="stack">
          <span class="muted">请输入服务端名称</span>
          <input :value="props.name" :disabled="props.creating" placeholder="例如：Survival-01" autocomplete="off" autofocus @input="emit('update:name', ($event.target as HTMLInputElement).value)" />
        </label>
        <p v-if="props.creating" class="muted" role="status">正在初始化实例目录并复制 MCDReforged 模板，请稍候…</p>
        <p v-if="props.error" class="danger-note" role="alert">{{ props.error }}</p>
        <div class="row">
          <button class="primary" type="submit" :disabled="props.creating || !props.name.trim()"><AppIcon :name="props.creating ? 'loader' : 'plus'" :spin="props.creating" />{{ props.creating ? '正在创建…' : '创建并进入控制台' }}</button>
          <button type="button" :disabled="props.creating" @click="emit('close')">取消</button>
        </div>
      </form>
    </div>
  </Transition>
</template>

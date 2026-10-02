<script setup lang="ts">
const emit = defineEmits<{
  create: [];
}>();
</script>

<template>
  <section class="landing-shell" aria-labelledby="landing-title">
    <div class="landing-hero card">
      <div class="brand landing-brand">
        <div class="brand-mark"><AppLogo /></div>
        <div>
          <div class="brand-title">MCTManager</div>
          <div class="brand-subtitle">Agent Ops Panel</div>
        </div>
      </div>

      <div class="landing-copy">
        <p class="eyebrow">Instance Panel</p>
        <h1 id="landing-title">Agent 驱动的 Minecraft 服务端</h1>
      </div>
    </div>

    <div class="card stack landing-card">
      <div class="card-header">
        <div>
          <p class="eyebrow">Create Instance</p>
          <h2 class="card-title">新建实例</h2>
        </div>
      </div>
      <button class="primary landing-create-button" type="button" @click="emit('create')"><AppIcon name="plus" />开始</button>
    </div>
  </section>
</template>

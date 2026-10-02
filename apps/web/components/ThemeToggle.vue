<script setup lang="ts">
const { isDark, toggleTheme } = useTheme();
const label = computed(() => isDark.value ? "切换到亮色模式" : "切换到暗色模式");
</script>

<template>
  <button type="button" class="theme-toggle" :title="label" :aria-label="label" :aria-pressed="!isDark" @click="toggleTheme">
    <AppIcon :name="isDark ? 'sun' : 'moon'" />
  </button>
</template>

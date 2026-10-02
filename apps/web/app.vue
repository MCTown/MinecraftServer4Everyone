<script setup lang="ts">
const { theme } = useTheme();
useHead(() => ({
  htmlAttrs: { "data-theme": theme.value },
  meta: [{ name: "theme-color", content: theme.value === "dark" ? "#141619" : "#f7f9f7" }]
}));
</script>

<template>
  <NuxtPage />
</template>

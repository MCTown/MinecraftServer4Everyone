<script setup lang="ts">
definePageMeta({ layout: false });

const { api } = useApi();
const password = ref("");
const error = ref("");
const loading = ref(false);
const router = useRouter();

async function handleLogin() {
  if (loading.value) return;
  if (!password.value.trim()) {
    error.value = "请输入密码";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    await api<{ success: boolean }>("/api/auth/login", {
      method: "POST",
      body: { password: password.value }
    });
    await router.replace("/");
  } catch (e: any) {
    error.value = e?.data?.error || e?.message || "登录失败，请稍后重试";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <ThemeToggle class="login-theme-toggle" />
    <LoginParticleBackground />
    <div class="login-card">
      <div class="login-logo">
        <AppLogo />
      </div>
      <h1 class="login-title">Minecraft Server Agent</h1>
      <p class="login-subtitle">请输入密码以访问面板</p>
      <form class="login-form" @submit.prevent="handleLogin">
        <input
          v-model="password"
          type="password"
          placeholder="输入访问密码"
          autocomplete="current-password"
          autofocus
        />
        <p v-if="error" class="login-error">{{ error }}</p>
        <button type="submit" :disabled="loading">
          <AppIcon :name="loading ? 'loader' : 'arrowRight'" :spin="loading" />
          {{ loading ? "验证中..." : "进入面板" }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  background: var(--bg-deep);
  position: relative;
  isolation: isolate;
}

.login-page::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  background: var(--login-backdrop);
}

.login-card {
  position: relative;
  z-index: 2;
  width: min(22rem, 90vw);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 1rem;
  padding: 2.5rem 2rem;
  box-shadow: var(--shadow);
  text-align: center;
}

.login-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 4.5rem;
  height: 4.5rem;
  margin: 0 auto 1.2rem;
  border: 1px solid rgba(145, 182, 201, 0.3);
  border-radius: 1rem;
  background: var(--blue-soft);
  color: var(--blue);
}

.login-logo :deep(.app-logo) { width: 44px; height: 44px; }

.login-title {
  font-size: 1.35rem;
  font-weight: 700;
  margin: 0 0 0.3rem;
  color: var(--text);
}

.login-subtitle {
  font-size: 0.88rem;
  color: var(--muted);
  margin: 0 0 1.8rem;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.login-form input {
  text-align: center;
  font-size: 1rem;
  letter-spacing: 0.04em;
}

.login-form button {
  justify-content: center;
  margin-top: 0.3rem;
  padding: 0.72rem;
  font-size: 0.95rem;
  font-weight: 600;
  background: var(--blue);
  border-color: var(--blue);
  color: var(--accent-contrast);
}

.login-form button:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.login-error {
  margin: 0;
  font-size: 0.82rem;
  color: var(--red);
}
</style>

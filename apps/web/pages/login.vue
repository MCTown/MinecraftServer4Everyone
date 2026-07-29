<script setup lang="ts">
definePageMeta({ layout: false });

const { api } = useApi();
const password = ref("");
const error = ref("");
const loading = ref(false);
const router = useRouter();

async function handleLogin() {
  if (!password.value.trim()) {
    error.value = "请输入密码";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const result = await api<{ success: boolean; token: string }>("/api/auth/login", {
      method: "POST",
      body: { password: password.value }
    });
    const maxAge = 7 * 24 * 60 * 60;
    document.cookie = `mcsa_token=${result.token}; path=/; max-age=${maxAge}; SameSite=Lax`;
    router.replace("/");
  } catch (e: any) {
    error.value = e?.data?.error || e?.message || "登录失败";
  } finally {
    loading.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") handleLogin();
}
</script>

<template>
  <div class="login-page">
    <LoginParticleBackground />
    <div class="login-card">
      <div class="login-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="40" height="40">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
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
          @keydown="onKeydown"
        />
        <p v-if="error" class="login-error">{{ error }}</p>
        <button type="submit" :disabled="loading">
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
  background:
    radial-gradient(circle at 10% 6%, rgba(229, 169, 0, 0.14), transparent 26rem),
    radial-gradient(circle at 92% 12%, rgba(102, 172, 105, 0.08), transparent 24rem),
    linear-gradient(180deg, rgba(20, 16, 14, 0.88) 0%, rgba(14, 10, 9, 0.9) 48%, rgba(12, 9, 8, 0.94) 100%);
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
  border-radius: 50%;
  background: var(--blue-soft);
  color: var(--blue);
}

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
  margin-top: 0.3rem;
  padding: 0.72rem;
  font-size: 0.95rem;
  font-weight: 600;
  background: var(--blue);
  border-color: var(--blue);
  color: #110c0b;
}

.login-form button:hover:not(:disabled) {
  background: #c48f00;
  border-color: #c48f00;
}

.login-error {
  margin: 0;
  font-size: 0.82rem;
  color: var(--red);
}
</style>

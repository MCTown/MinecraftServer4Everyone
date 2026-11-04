<script setup lang="ts">
import type { BackendNode } from "~/composables/useBackendNodes";

const props = defineProps<{ open: boolean; nodeId: string; beforeRemove: (id: string) => boolean }>();
const emit = defineEmits<{ close: []; "after-leave": []; select: [id: string]; removed: [id: string, nextId: string] }>();
const { api } = useApi();
const { registry, error, refresh, add, remove } = useBackendNodes();
const dialog = ref<HTMLElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const addButton = ref<HTMLButtonElement | null>(null);
const loading = ref(false);
const saving = ref(false);
const showAdd = ref(false);
const removing = ref<BackendNode | null>(null);
const mutationError = ref("");
const notice = ref("");
const form = reactive({ name: "", url: "", accessKey: "" });
const statuses = ref<Record<string, string>>({});
let generation = 0;
const labels: Record<string, string> = { online: "在线", offline: "无法连接", unauthorized: "凭据无效", incompatible: "后端需要升级" };

function resetForm() { form.name = ""; form.url = ""; form.accessKey = ""; }
function close() {
  if (saving.value) return;
  resetForm();
  emit("close");
}

async function load() {
  const current = ++generation;
  loading.value = true;
  statuses.value = {};
  try {
    await refresh();
    if (current !== generation) return;
    await Promise.all(registry.value.nodes.map(async (node) => {
      try {
        const result = await api<{ status: string }>(`/api/connector/nodes/${encodeURIComponent(node.id)}/status`);
        if (current === generation) statuses.value[node.id] = result.status;
      } catch { if (current === generation) statuses.value[node.id] = "offline"; }
    }));
  } catch { /* The shared registry error is rendered below. */ }
  finally { if (current === generation) loading.value = false; }
}

function openAdd() {
  showAdd.value = true;
  removing.value = null;
  mutationError.value = "";
  notice.value = "";
  void nextTick(() => nameInput.value?.focus());
}

function cancelAdd() {
  if (saving.value) return;
  showAdd.value = false;
  resetForm();
  mutationError.value = "";
  void nextTick(() => addButton.value?.focus());
}

async function createNode() {
  if (saving.value) return;
  saving.value = true;
  mutationError.value = "";
  notice.value = "";
  generation++; // Invalidate status results for the former list.
  loading.value = false;
  try {
    const node = await add({ name: form.name.trim(), url: form.url.trim(), accessKey: form.accessKey });
    resetForm();
    showAdd.value = false;
    notice.value = `已添加「${node.name}」，可从列表切换使用。`;
    if (!props.nodeId) emit("select", node.id);
    else {
      void load();
      void nextTick(() => dialog.value?.querySelector<HTMLButtonElement>(`[data-node-id="${node.id}"]`)?.focus());
    }
  } catch (cause: any) {
    mutationError.value = cause?.data?.error ?? "添加结果未确认，请先刷新列表检查，不要重复提交。";
  } finally { saving.value = false; }
}

function requestRemoval(node: BackendNode) {
  if (saving.value) return;
  cancelAdd();
  notice.value = "";
  removing.value = node;
  void nextTick(() => dialog.value?.querySelector<HTMLButtonElement>(".backend-remove-confirm")?.focus());
}

async function confirmRemoval() {
  const node = removing.value;
  if (!node || saving.value) return;
  mutationError.value = "";
  if (!props.beforeRemove(node.id)) { mutationError.value = "请先保存当前修改并完成正在进行的操作，再移除当前后端。"; return; }
  saving.value = true;
  generation++;
  loading.value = false;
  try {
    const result = await remove(node.id);
    removing.value = null;
    notice.value = `已移除「${node.name}」的连接，后端数据未删除。`;
    emit("removed", node.id, result.defaultNodeId);
    if (node.id !== props.nodeId) {
      void load();
      void nextTick(() => addButton.value?.focus());
    }
  } catch (cause: any) {
    mutationError.value = cause?.data?.error ?? "移除结果未确认，请刷新列表检查；后端数据不会被删除。";
  } finally { saving.value = false; }
}

function keydown(event: KeyboardEvent) {
  if (event.key === "Escape") { event.preventDefault(); close(); return; }
  if (event.key !== "Tab") return;
  const items = [...(dialog.value?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']") ?? [])].filter((element) => element.offsetParent !== null);
  if (!items.length) { event.preventDefault(); return; }
  const index = items.indexOf(document.activeElement as HTMLElement);
  event.preventDefault();
  items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
}

watch(() => props.open, (open) => {
  if (open) {
    showAdd.value = false;
    removing.value = null;
    mutationError.value = "";
    notice.value = "";
    void nextTick(() => dialog.value?.focus());
    void load();
  } else { generation++; resetForm(); }
});
onBeforeUnmount(() => { generation++; resetForm(); });
</script>

<template>
  <Transition name="modal" @after-leave="emit('after-leave')">
    <div v-if="props.open" class="modal-backdrop backend-switcher-backdrop" @click.self="close">
      <section ref="dialog" class="card backend-switcher" role="dialog" aria-modal="true" aria-labelledby="backend-switcher-title" :aria-busy="saving" tabindex="-1" @keydown="keydown">
        <header class="card-header">
          <div><p class="eyebrow">Connector</p><h2 id="backend-switcher-title" class="card-title">后端实例管理</h2></div>
          <button type="button" :disabled="saving" aria-label="关闭后端实例管理" @click="close"><AppIcon name="close" /></button>
        </header>
        <p class="muted backend-switcher-description">切换、添加或移除连接。每个后端独立管理 Minecraft 实例、文件与 Agent 对话。</p>
        <p v-if="error || mutationError" class="backend-switcher-error" role="alert">{{ mutationError || error }}</p>
        <p v-if="notice" class="backend-switcher-notice" role="status">{{ notice }}</p>
        <div class="backend-node-list" :aria-busy="loading">
          <div v-for="node in registry.nodes" :key="node.id" class="backend-node-row">
            <button type="button" class="backend-node" :class="{ active: node.id === props.nodeId }" :data-node-id="node.id" :aria-pressed="node.id === props.nodeId" :disabled="saving" @click="emit('select', node.id)">
              <span class="backend-node-icon"><AppIcon name="server" /></span>
              <span class="backend-node-copy"><strong>{{ node.name }}</strong><small>{{ node.id }}{{ node.id === registry.defaultNodeId ? ' · 默认节点' : '' }}</small></span>
              <span class="backend-node-status" :data-status="statuses[node.id] ?? 'checking'" role="status">{{ labels[statuses[node.id] ?? ''] ?? '检测中' }}</span>
              <AppIcon v-if="node.id === props.nodeId" name="check" />
            </button>
            <button v-if="registry.canManage" type="button" class="backend-node-remove" :aria-label="`移除后端 ${node.name}`" :title="`移除 ${node.name} 的连接，不删除后端数据`" :disabled="saving" @click="requestRemoval(node)"><AppIcon name="trash" /></button>
          </div>
          <p v-if="!registry.nodes.length && !loading" class="muted backend-empty">尚未添加后端，点击下方按钮连接第一台服务器。</p>
        </div>

        <section v-if="removing" class="backend-remove-warning" aria-labelledby="backend-remove-title">
          <strong id="backend-remove-title">移除「{{ removing.name }}」？</strong>
          <p>只删除连接器中的登记，并断开该节点的管理连接；不会停止 Minecraft 或删除实例、文件及后端数据。</p>
          <p v-if="removing.id === props.nodeId">{{ registry.nodes.length > 1 ? '这是当前后端，移除后将切换到其他节点。' : '这是最后一个后端，移除后可重新添加。' }}</p>
          <div class="backend-form-actions"><button type="button" :disabled="saving" @click="removing = null; mutationError = ''">取消</button><button type="button" class="danger backend-remove-confirm" :disabled="saving" @click="confirmRemoval"><AppIcon :name="saving ? 'loader' : 'trash'" :spin="saving" />{{ saving ? '正在移除…' : '确认移除连接' }}</button></div>
        </section>

        <form v-if="showAdd" class="backend-add-form" @submit.prevent="createNode">
          <h3>添加后端</h3>
          <fieldset :disabled="saving">
            <label><span>名称</span><input ref="nameInput" v-model="form.name" aria-label="后端名称" maxlength="100" placeholder="例如：家里的服务器" required /></label>
            <label><span>后端地址</span><input v-model="form.url" type="url" aria-label="后端地址" placeholder="http://10.0.0.11:8787" autocomplete="off" required /><small class="muted">填写后端 API 的 HTTP(S) 地址，不要填写前端面板地址或附加路径。</small></label>
            <label><span>访问密钥</span><input v-model="form.accessKey" type="password" aria-label="后端访问密钥" maxlength="4096" placeholder="后端的 APP_ACCESS_KEY" autocomplete="new-password" spellcheck="false" required /><small class="muted">与目标后端的 APP_ACCESS_KEY 相同。仅保存在连接器服务器，不回显、不保存到浏览器。</small></label>
          </fieldset>
          <div class="backend-form-actions"><button type="button" :disabled="saving" @click="cancelAdd">取消</button><button type="submit" class="primary" :disabled="saving || !form.name.trim() || !form.url.trim() || !form.accessKey"><AppIcon :name="saving ? 'loader' : 'plus'" :spin="saving" />{{ saving ? '正在保存…' : '保存后端' }}</button></div>
        </form>

        <footer class="backend-switcher-footer">
          <span v-if="!registry.canManage" class="muted">{{ registry.managementDisabledReason || '正在读取节点管理权限…' }}</span>
          <button v-else ref="addButton" type="button" :disabled="saving || registry.nodes.length >= 100" @click="openAdd"><AppIcon name="plus" />添加后端</button>
          <button type="button" :disabled="loading || saving" @click="load"><AppIcon :name="loading ? 'loader' : 'refresh'" :spin="loading" />刷新</button>
        </footer>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.backend-switcher-backdrop { z-index: 70; align-items: end; justify-content: start; padding: 1rem 1rem 1rem 4.8rem; }
.backend-switcher { display: grid; gap: 0.8rem; width: min(35rem, 100%); max-height: calc(100dvh - 2rem); overflow: auto; border-color: var(--line-strong); box-shadow: var(--shadow); }
.backend-switcher .card-header { display: flex; align-items: center; justify-content: space-between; margin: 0; }
.backend-switcher-description { margin: 0; font-size: 0.78rem; line-height: 1.6; }
.backend-node-list { display: grid; gap: 0.4rem; max-height: 35dvh; overflow: auto; min-height: 0; }
.backend-node-row { display: flex; align-items: stretch; gap: 0.3rem; min-width: 0; }
.backend-node { display: flex; align-items: center; flex: 1; gap: 0.65rem; min-width: 0; min-height: 4rem; padding: 0.7rem; text-align: left; background: var(--panel-soft); }
.backend-node.active { border-color: var(--blue); box-shadow: inset 2px 0 0 var(--blue); }
.backend-node-icon { color: var(--blue); flex-shrink: 0; }
.backend-node-copy { display: grid; flex: 1; gap: 0.3rem; min-width: 0; }
.backend-node-copy strong { overflow-wrap: anywhere; }
.backend-node-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.backend-node-copy small, .backend-node-status { color: var(--muted); font-size: 0.68rem; }
.backend-node-status { flex-shrink: 0; }
.backend-node-status[data-status="online"], .backend-switcher-notice { color: var(--green); }
.backend-node-status[data-status="offline"], .backend-node-status[data-status="unauthorized"], .backend-node-status[data-status="incompatible"], .backend-switcher-error { color: var(--red); }
.backend-node-remove { flex-shrink: 0; color: var(--muted); padding: 0.6rem; }
.backend-node-remove:hover:not(:disabled) { color: var(--red); border-color: var(--red); }
.backend-switcher-footer, .backend-form-actions { display: flex; align-items: center; justify-content: space-between; gap: 0.7rem; }
.backend-switcher-footer { border-top: 1px solid var(--line); padding-top: 0.7rem; font-size: 0.68rem; }
.backend-switcher-footer button { flex-shrink: 0; }
.backend-add-form, .backend-remove-warning { display: grid; gap: 0.8rem; padding: 1rem; border-radius: 0.4rem; background: var(--panel-soft); }
.backend-add-form h3 { margin: 0; font-size: 0.9rem; }
.backend-add-form fieldset { display: grid; gap: 0.8rem; min-width: 0; border: 0; padding: 0; margin: 0; }
.backend-add-form label { display: grid; gap: 0.35rem; min-width: 0; font-size: 0.78rem; }
.backend-add-form input { width: 100%; min-width: 0; }
.backend-add-form small, .backend-remove-warning p, .backend-switcher-notice, .backend-switcher-error, .backend-empty { margin: 0; font-size: 0.72rem; line-height: 1.65; overflow-wrap: anywhere; }
.backend-remove-warning { border: 1px solid var(--red); }
.backend-form-actions { justify-content: flex-end; }
@media (max-width: 820px) { .backend-switcher-backdrop { padding: 0.75rem; } .backend-switcher { max-height: calc(100dvh - 1.5rem); } .backend-node { padding: 0.6rem; gap: 0.4rem; } }
</style>

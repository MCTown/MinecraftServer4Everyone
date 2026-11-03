<script setup lang="ts">
import FileWorkspace from "~/components/files/FileWorkspace.client.vue";
const { api } = useApi();
const customized = ref(false), loading = ref(true), resetting = ref(false), busy = ref(false), error = ref("");
const workspaceDirty = useState<boolean>("mcdr-template-dirty", () => false);
const workspace = ref<{ refresh(): Promise<void>; canLeave(): boolean; clearEditor(): void } | null>(null);
async function loadState() {
  try { customized.value = (await api<{ customized: boolean }>("/api/settings/mcdr-template")).customized; }
  catch (e: any) { error.value = e?.data?.error ?? e?.message ?? "无法读取模板状态"; }
  finally { loading.value = false; }
}
async function refresh() { await loadState(); await workspace.value?.refresh(); }
async function reset() {
  if (busy.value || workspaceDirty.value) { error.value = "请先保存或撤销文件修改，并等待文件操作完成，再恢复默认模板。"; return; }
  if (!window.confirm("恢复内置默认模板？所有自定义模板文件都会被删除，已有实例不受影响。")) return;
  resetting.value = true; error.value = "";
  try {
    await api("/api/settings/mcdr-template/reset", { method: "POST" });
    workspace.value?.clearEditor();
    await refresh();
  } catch (e: any) { error.value = e?.data?.error ?? e?.message ?? "恢复默认模板失败"; }
  finally { resetting.value = false; }
}
onMounted(loadState);
defineExpose({ refresh });
</script>

<template>
  <div class="template-editor finder-template">
    <section class="settings-surface"><div class="settings-surface-heading"><span class="settings-category-icon"><AppIcon name="archive" /></span><div><h2>MCDReforged 模板</h2><p>仅影响之后新建的实例，已有实例不受影响。Minecraft 本体放在 server/。</p></div><span class="settings-badge">{{ loading ? '读取中' : customized ? '已自定义' : '内置默认' }}</span></div><div class="settings-actions"><span class="muted">支持复制、移动、ZIP 压缩与解压；重名不覆盖。</span><button type="button" :disabled="busy || resetting || workspaceDirty || !customized" @click="reset"><AppIcon :name="resetting ? 'loader' : 'history'" :spin="resetting" />{{ resetting ? '恢复中' : '恢复默认' }}</button></div></section>
    <p v-if="error" class="settings-warning-note" role="alert">{{ error }}</p>
    <div class="finder-template-workbench" :inert="resetting || undefined"><ClientOnly><FileWorkspace id="mcdr-template-files" ref="workspace" api-path="/api/settings/mcdr-template/manager" @changed="loadState" @busy-change="busy = $event" @dirty-change="workspaceDirty = $event" /><template #fallback><AsyncPlaceholder label="正在加载模板文件管理器" :rows="7" /></template></ClientOnly></div>
  </div>
</template>

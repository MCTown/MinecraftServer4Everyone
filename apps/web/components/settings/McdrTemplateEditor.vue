<script setup lang="ts">
import type { FileEntry } from "~/types/app";
import { formatBytes } from "~/utils/formatters";

interface TemplateState { customized: boolean; files: FileEntry[] }

const { api, upload } = useApi();
// Survive settings tab switches so an unsaved edit is never silently dropped.
const state = useState<TemplateState | null>("mcdr-template-state", () => null);
const selectedPath = useState<string>("mcdr-template-selected", () => "config.yml");
const savedContent = useState<string | null>("mcdr-template-saved", () => null);
const draft = useState<string | null>("mcdr-template-draft", () => null);
const workspaceDirty = useState<boolean>("mcdr-template-dirty", () => false);
const loading = ref(false), busy = ref(false), error = ref(""), notice = ref("");
const uploadInput = ref<HTMLInputElement | null>(null);

const selected = computed(() => state.value?.files.find((file) => file.path === selectedPath.value));
const dirty = computed(() => draft.value !== null && draft.value !== savedContent.value);
watch(dirty, (value) => { workspaceDirty.value = value; }, { immediate: true });
const targetDirectory = computed(() => {
  const file = selected.value;
  if (!file) return ".";
  if (file.type === "directory") return file.path;
  return file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
});
const depth = (file: FileEntry) => file.path.split("/").length - 1;

function message(e: any, fallback: string) { return e?.data?.error ?? e?.data?.message ?? e?.message ?? fallback; }

async function openFile(file: FileEntry | undefined) {
  if (!file || file.type !== "file" || !file.editable) { savedContent.value = null; draft.value = null; return; }
  const content = (await api<{ content: string }>("/api/settings/mcdr-template/text", { query: { path: file.path } })).content;
  savedContent.value = content; draft.value = content;
}

async function load() {
  if (dirty.value) { error.value = "有未保存的修改。请先保存或撤销，再刷新。"; return; }
  loading.value = true; error.value = "";
  try {
    state.value = await api<TemplateState>("/api/settings/mcdr-template");
    if (!selected.value) selectedPath.value = state.value.files.find((file) => file.editable)?.path ?? "";
    await openFile(selected.value);
  } catch (e) { error.value = message(e, "无法加载模板"); }
  finally { loading.value = false; }
}

async function select(file: FileEntry) {
  if (file.path === selectedPath.value) return;
  if (dirty.value && !window.confirm(`「${selectedPath.value}」有未保存的修改，确定放弃吗？`)) return;
  selectedPath.value = file.path; error.value = ""; notice.value = "";
  try { await openFile(file); } catch (e) { error.value = message(e, "无法读取文件"); }
}

async function run(action: () => Promise<TemplateState>, done: string) {
  busy.value = true; error.value = ""; notice.value = "";
  try { state.value = await action(); notice.value = done; return true; }
  catch (e) { error.value = message(e, "操作失败"); return false; }
  finally { busy.value = false; }
}

async function save() {
  if (!dirty.value || draft.value === null) return;
  const content = draft.value;
  if (await run(() => api<TemplateState>("/api/settings/mcdr-template/text", { method: "PUT", body: { path: selectedPath.value, content } }), "已保存，之后新建的实例会使用此模板。")) savedContent.value = content;
}

function revert() { draft.value = savedContent.value; }

async function createFolder() {
  const name = window.prompt(`在「${targetDirectory.value}」下新建文件夹`, "")?.trim();
  if (!name) return;
  const path = targetDirectory.value === "." ? name : `${targetDirectory.value}/${name}`;
  await run(() => api<TemplateState>("/api/settings/mcdr-template/folder", { method: "POST", body: { path } }), `已创建 ${path}`);
}

async function uploadFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  for (const file of files) {
    const body = new FormData();
    body.append("path", targetDirectory.value);
    body.append("file", file, file.name);
    if (!await run(() => upload<TemplateState>("/api/settings/mcdr-template/upload", body), `已上传 ${files.length} 个文件到 ${targetDirectory.value}`)) return;
  }
}

async function remove(file: FileEntry) {
  if (!window.confirm(`从模板中删除「${file.path}」${file.type === "directory" ? "及其全部内容" : ""}？已有实例不受影响。`)) return;
  if (await run(() => api<TemplateState>("/api/settings/mcdr-template", { method: "DELETE", query: { path: file.path } }), `已删除 ${file.path}`) && !selected.value) {
    savedContent.value = null; draft.value = null;
  }
}

async function reset() {
  if (!window.confirm("恢复为内置默认模板？所有自定义修改都会被删除，已有实例不受影响。")) return;
  if (await run(() => api<TemplateState>("/api/settings/mcdr-template/reset", { method: "POST" }), "已恢复内置默认模板。")) {
    if (!selected.value) selectedPath.value = "config.yml";
    await openFile(selected.value).catch((e) => { error.value = message(e, "无法读取文件"); });
  }
}

function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) event.preventDefault(); }
onMounted(() => { if (!state.value) void load(); window.addEventListener("beforeunload", beforeUnload); });
onBeforeUnmount(() => window.removeEventListener("beforeunload", beforeUnload));
defineExpose({ refresh: load });
</script>

<template>
  <div class="template-editor">
    <AsyncPlaceholder v-if="!state && loading" variant="form" label="正在加载 MCDR 模板" :rows="4" />
    <AsyncPlaceholder v-else-if="!state && error" :error="error" @retry="load" />
    <template v-else-if="state">
      <section class="settings-surface">
        <div class="settings-surface-heading">
          <span class="settings-category-icon"><AppIcon name="archive" /></span>
          <div><h2>MCDReforged 模板</h2><p>新建服务端时会把这些文件复制到实例根目录，Minecraft 本体放在 server/。修改不会影响已有实例。</p></div>
          <span class="settings-badge">{{ state.customized ? '已自定义' : '内置默认' }}</span>
        </div>
        <div class="settings-actions template-toolbar">
          <button type="button" :disabled="busy" @click="uploadInput?.click()"><AppIcon name="upload" />上传到 {{ targetDirectory === '.' ? '根目录' : `${targetDirectory}/` }}</button>
          <button type="button" :disabled="busy" @click="createFolder"><AppIcon name="folder" />新建文件夹</button>
          <button type="button" :disabled="busy || !state.customized" @click="reset"><AppIcon name="history" />恢复默认</button>
          <input ref="uploadInput" type="file" multiple hidden @change="uploadFiles" />
        </div>
      </section>
      <p v-if="error" class="settings-warning-note" role="alert"><AppIcon name="warning" />{{ error }}</p>
      <p v-if="notice" class="template-notice" role="status"><AppIcon name="check" />{{ notice }}</p>
      <div class="template-workbench">
        <ul class="template-tree" aria-label="模板文件">
          <li v-for="file in state.files" :key="file.path" :class="{ active: file.path === selectedPath }">
            <button type="button" class="template-entry" :style="{ paddingLeft: `${10 + depth(file) * 16}px` }" :aria-current="file.path === selectedPath ? 'true' : undefined" @click="select(file)">
              <AppIcon :name="file.type === 'directory' ? 'folder' : file.editable ? 'fileCode' : 'file'" /><span>{{ file.name }}</span><small v-if="file.type === 'file'">{{ formatBytes(file.size) }}</small>
            </button>
            <button type="button" class="template-delete" :disabled="busy" :aria-label="`删除 ${file.path}`" @click="remove(file)"><AppIcon name="trash" /></button>
          </li>
        </ul>
        <div class="template-pane">
          <template v-if="selected?.type === 'file' && selected.editable && draft !== null">
            <div class="template-pane-header"><code>{{ selected.path }}</code><span class="template-draft-state" :class="{ dirty }">{{ dirty ? '未保存' : '已保存' }}</span></div>
            <div class="template-code"><CodeEditor v-model="draft" :readonly="busy" /></div>
            <footer class="settings-save-bar template-save-bar"><span><AppIcon name="info" />仅影响之后新建的实例</span><div class="settings-actions"><button type="button" :disabled="!dirty || busy" @click="revert">撤销更改</button><button type="button" class="primary" :disabled="!dirty || busy" @click="save"><AppIcon :name="busy ? 'loader' : 'save'" :spin="busy" />保存</button></div></footer>
          </template>
          <div v-else class="settings-empty">
            <AppIcon :name="selected?.type === 'directory' ? 'folder' : 'file'" :size="30" />
            <strong>{{ selected ? selected.path : '选择一个文件' }}</strong>
            <span>{{ !selected ? '左侧选择文本文件即可在线编辑。' : selected.type === 'directory' ? '上传或新建的文件会放到这个目录。' : '二进制文件（如 .mcdr / .pyz 插件）不能在线编辑，可删除后重新上传。' }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style>
.template-editor { display: grid; gap: 18px; min-width: 0; }
.template-toolbar { flex-wrap: wrap; }
.template-notice { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--green); font-size: 12px; }
.template-workbench { display: grid; grid-template-columns: minmax(220px, .42fr) minmax(0, 1fr); min-width: 0; min-height: 560px; background: var(--surface-card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.template-tree { margin: 0; padding: 8px 0; list-style: none; max-height: 640px; overflow: auto; border-right: 1px solid var(--border); background: var(--surface-page); }
.template-tree li { display: flex; align-items: center; min-width: 0; }
.template-tree li.active { background: var(--accent-soft); }
.settings-theme .template-tree button { border: 0; background: transparent; box-shadow: none; border-radius: 0; }
.settings-theme .template-tree .template-entry { flex: 1; min-width: 0; min-height: 32px; justify-content: flex-start; gap: 7px; padding-block: 6px; padding-right: 6px; color: var(--fg-secondary); font-size: 12px; text-align: left; }
.template-entry span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.template-entry small { flex: none; color: var(--fg-faint); font-size: 10px; }
.template-entry .app-icon { flex: none; --icon-size: 14px; color: var(--fg-muted); }
.template-tree li.active .template-entry, .template-tree li.active .template-entry .app-icon { color: var(--accent); }
.settings-theme .template-tree .template-delete { flex: none; min-height: 28px; padding: 4px 10px; color: var(--fg-faint); opacity: 0; }
.template-tree li:hover .template-delete, .template-tree li.active .template-delete, .template-delete:focus-visible { opacity: 1; }
.settings-theme .template-tree .template-delete:hover { color: var(--red, #d64545); }
.template-pane { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 16px; }
.template-pane-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.template-pane-header code { color: var(--fg); font-size: 12px; overflow-wrap: anywhere; }
.template-draft-state { flex: none; color: var(--fg-muted); font-size: 11px; }
.template-draft-state.dirty { color: var(--yellow); }
.template-code { flex: 1; min-height: 440px; height: 520px; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-code); }
.template-code .cm-host, .template-code .cm-editor { height: 100%; }
.template-pane > .settings-empty { flex: 1; }
@media (max-width: 680px) {
  .template-workbench { grid-template-columns: minmax(0, 1fr); min-height: 0; }
  .template-tree { max-height: 280px; border-right: 0; border-bottom: 1px solid var(--border); }
  .template-delete { opacity: 1 !important; }
  .template-code { height: 420px; min-height: 320px; }
  .template-save-bar { flex-wrap: wrap; }
}
</style>

<script setup lang="ts">
import { VueFinder, useVueFinder, contextMenuItems, type Item, type DirEntry, type ItemDclickEvent, type VueFinderComposable } from "vuefinder";
import zhCN from "vuefinder/dist/locales/zhCN.js";
import XHRUpload from "@uppy/xhr-upload";
import CodeEditor from "~/components/CodeEditor.vue";
import { createFileManagerDriver, fromFinderPath, toFinderPath } from "~/utils/fileManagerDriver";
import { readBrowserState, writeBrowserState } from "~/utils/browserState";
import { initializeFileManagerPreferences } from "~/utils/fileManagerPreferences";

const props = withDefaults(defineProps<{ id: string; apiPath: string; initialPath?: string }>(), { initialPath: "." });
const emit = defineEmits<{ changed: []; "path-change": [path: string]; "busy-change": [busy: boolean]; "dirty-change": [dirty: boolean] }>();
provide("VueFinderOptions", { i18n: { zhCN: {
  ...zhCN,
  "File info": "文件信息", Type: "类型", Dimensions: "尺寸", Duration: "时长", Path: "路径",
  "Download help": "下载帮助", "File %s of %s": "第 %s 个文件，共 %s 个", Recent: "最近访问",
  "Remove from recent": "从最近访问中移除", "Edit this path": "编辑路径", "No recent folders yet.": "暂无最近访问的文件夹。",
  "No matching folders.": "没有匹配的文件夹。", "Folder not found": "找不到文件夹", "Loading…": "正在加载…",
  "Show as table": "显示为表格", "Toggle word wrap": "切换自动换行", "Word wrap on — click to disable": "自动换行已开启，点击关闭",
  "Word wrap off — click to enable": "自动换行已关闭，点击开启",
  "Search Files": "搜索文件", Filter: "筛选", "Toggle Tree View": "切换目录树",
  "Found %s results": "找到 %s 个结果"
} }, locale: "zhCN" });
initializeFileManagerPreferences(props.id, undefined, window.matchMedia("(min-width: 821px)").matches);
const { api, baseURL, downloadUrl } = useApi();
const { isDark } = useTheme();
const host = ref<HTMLElement | null>(null);
let finder: VueFinderComposable | undefined;
const editable = new Set<string>();
const draft = useState<{ path: string; content: string; saved: string } | null>(`file-draft:${props.id}`, () => readBrowserState(`file-draft:${props.id}`));
const editorOpen = ref(Boolean(draft.value));
const editorLoading = ref(false), editorSaving = ref(false), editorError = ref("");
const currentPath = ref(props.initialPath);
const operationCount = ref(0), uploading = ref(false);
const busy = computed(() => operationCount.value > 0 || uploading.value || editorSaving.value);
const dirty = computed(() => Boolean(draft.value && draft.value.content !== draft.value.saved));
const uploaders = new Set<any>();
let editorRequest = 0;
watch(busy, (value) => emit("busy-change", value), { immediate: true });
watch(dirty, (value) => emit("dirty-change", value), { immediate: true });
watch(draft, (value) => writeBrowserState(`file-draft:${props.id}`, value), { deep: true });
// VueFinder watches config.theme; keep the instance alive during palette changes
// so an in-flight upload or selection is not discarded.
const config = computed(() => ({ initialPath: toFinderPath(currentPath.value), persist: false, view: "list" as const, showTreeView: true, showThumbnails: false, showMenuBar: true, theme: isDark.value ? "midnight" as const : "silver" as const, maxFileSize: "20gb", listItemHeight: 36 }));

function errorMessage(error: any) { return error?.data?.error ?? error?.message ?? "文件操作失败"; }
async function refresh() { await finder?.refresh(); }
function canLeave() {
  if (busy.value) { window.alert("文件操作正在进行，请完成后再关闭。"); return false; }
  // Drafts survive workspace/tab changes, but ask before hiding the editor.
  return !dirty.value || window.confirm("有未保存的文件修改。关闭后会保留草稿，确定暂时离开吗？");
}

const driver = createFileManagerDriver({
  async request<T>(suffix: string, options: any = {}): Promise<T> {
    let result: T;
    try { result = await api<T>(`${props.apiPath}${suffix}`, options); }
    catch (error: any) { throw Object.assign(new Error(errorMessage(error)), { statusCode: error?.statusCode ?? error?.status }); }
    if (Array.isArray(result)) for (const file of result) {
      if (file.editable) editable.add(toFinderPath(file.path)); else editable.delete(toFinderPath(file.path));
    }
    return result;
  },
  url: (suffix, path) => downloadUrl(`${props.apiPath}${suffix}?path=${encodeURIComponent(path)}`),
  changed: () => emit("changed"),
  busy: (active) => { operationCount.value = Math.max(0, operationCount.value + (active ? 1 : -1)); },
  configureUploader(uppy, context) {
    uploaders.add(uppy);
    uppy.use(XHRUpload, {
      endpoint: `${baseURL}${props.apiPath}/upload`, fieldName: "file", formData: true, bundle: false, limit: 1,
      allowedMetaFields: ["path"],
      // Retrying a mutating POST after a lost response can only produce a name
      // conflict. Let the user inspect the refreshed directory before retrying.
      shouldRetry: () => false,
      onAfterResponse(xhr: XMLHttpRequest) {
        if (xhr.status >= 400) {
          let message = `上传失败（HTTP ${xhr.status}）`;
          try { message = JSON.parse(xhr.responseText).error || message; } catch { /* Non-JSON proxy error. */ }
          throw new Error(message);
        }
      },
      headers: () => {
        const token = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("mcsa_token="))?.slice("mcsa_token=".length);
        return token ? { authorization: `Bearer ${token}` } : {};
      },
      onBeforeRequest(xhr: XMLHttpRequest) { xhr.withCredentials = true; }
    });
    uppy.on("upload", () => {
      uploading.value = true;
      const directory = fromFinderPath(context.getTargetPath());
      for (const file of uppy.getFiles()) {
        // Preserve folder structure: the server deliberately rejects paths in
        // filename and accepts the parent through the sandboxed path field.
        const parts = String(file.name).replaceAll("\\", "/").split("/");
        const name = parts.pop()!;
        const parent = [directory === "." ? "" : directory, ...parts].filter(Boolean).join("/") || ".";
        // Leave Uppy/queue names intact for subsequent batches and renames.
        // XHRUpload uses meta.name as the multipart basename.
        uppy.setFileMeta(file.id, { path: parent, name });
      }
    });
    uppy.on("complete", () => { uploading.value = false; emit("changed"); });
    uppy.on("error", () => { uploading.value = false; });
    uppy.on("cancel-all", () => { uploading.value = false; });
  }
});

async function openText(item: DirEntry) {
  if (!editable.has(item.path) || editorSaving.value) return;
  if (dirty.value && draft.value?.path !== fromFinderPath(item.path) && !window.confirm("切换文件会放弃当前未保存的修改，确定继续吗？")) return;
  editorOpen.value = true; editorError.value = "";
  const request = ++editorRequest;
  if (draft.value?.path === fromFinderPath(item.path)) { editorLoading.value = false; return; }
  editorLoading.value = true;
  try {
    const result = await driver.getContent({ path: item.path });
    if (request !== editorRequest) return;
    draft.value = { path: fromFinderPath(item.path), content: result.content, saved: result.content };
  } catch (error) { if (request === editorRequest) editorError.value = errorMessage(error); }
  finally { if (request === editorRequest) editorLoading.value = false; }
}
function onDoubleClick(event: ItemDclickEvent) {
  if (editable.has(event.item.path)) { event.preventDefault(); void openText(event.item); }
}
async function saveText() {
  if (!draft.value || !dirty.value || editorSaving.value || editorLoading.value) return;
  editorSaving.value = true; editorError.value = "";
  const snapshot = { ...draft.value };
  try {
    await driver.save({ path: toFinderPath(snapshot.path), content: snapshot.content });
    if (draft.value?.path === snapshot.path) draft.value.saved = snapshot.content;
    await refresh();
  } catch (error) { editorError.value = errorMessage(error); }
  finally { editorSaving.value = false; }
}
function closeEditor() {
  if (editorSaving.value) return;
  if (dirty.value && !window.confirm("放弃该文件未保存的修改？")) return;
  clearEditor();
}
function clearEditor() { editorRequest++; draft.value = null; editorOpen.value = false; editorLoading.value = false; editorError.value = ""; }
const menu: Item[] = [{
  id: "edit-server-text", title: () => "编辑文本", order: 75,
  show: (_app, context) => Boolean(context.target && editable.has(context.target.path)),
  action: (_app, items) => { if (items[0]) void openText(items[0]); }
}, ...contextMenuItems];

function onPathChange(path: string) { currentPath.value = fromFinderPath(path); emit("path-change", currentPath.value); }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ""; } }
onMounted(() => window.addEventListener("beforeunload", beforeUnload));
onBeforeUnmount(() => {
  editorRequest++;
  window.removeEventListener("beforeunload", beforeUnload);
  for (const uppy of uploaders) uppy.destroy();
  emit("busy-change", false);
});
defineExpose({ refresh, canLeave, clearEditor });
</script>

<template>
  <div ref="host" class="file-workspace" :class="{ 'file-workspace-editing': editorOpen }">
    <VueFinder :id="props.id" :driver="driver" :config="config" :context-menu-items="menu" locale="zhCN" :features="{ edit: false, language: false, theme: false, fullscreen: false }" @ready="finder = useVueFinder(props.id)" @file-dclick="onDoubleClick" @path-change="onPathChange">
      <template #menubar-end>
        <button v-if="draft && !editorOpen" type="button" class="file-draft-trigger" @click="editorOpen = true">继续编辑 {{ draft.path }}<span v-if="dirty"> ●</span></button>
      </template>
    </VueFinder>
    <section v-if="editorOpen" class="file-text-pane" aria-label="文本文件编辑器" @keydown.ctrl.s.prevent="saveText" @keydown.meta.s.prevent="saveText">
      <header class="file-text-header"><div><AppIcon name="fileCode" /><code>{{ draft?.path ?? '读取文件' }}</code><span v-if="draft" class="file-draft-status">{{ dirty ? '未保存' : '已保存' }}</span></div><button type="button" :disabled="editorSaving" aria-label="关闭编辑器" @click="closeEditor"><AppIcon name="close" /></button></header>
      <AsyncPlaceholder v-if="editorLoading" variant="editor" label="正在读取文件" :rows="5" />
      <p v-if="editorError" class="file-error" role="alert">{{ editorError }}</p>
      <div v-if="!editorLoading && draft" class="file-text-code"><CodeEditor v-model="draft.content" :readonly="editorSaving" /></div>
      <footer class="file-text-footer"><span>Ctrl / ⌘ + S 保存</span><button type="button" :disabled="!dirty || editorSaving" @click="draft && (draft.content = draft.saved)">撤销更改</button><button type="button" class="primary" :disabled="!dirty || editorSaving || editorLoading" @click="saveText"><AppIcon :name="editorSaving ? 'loader' : 'save'" :spin="editorSaving" />{{ editorSaving ? '保存中' : '保存文件' }}</button></footer>
    </section>
  </div>
</template>

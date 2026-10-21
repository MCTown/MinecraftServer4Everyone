<script setup lang="ts">
import DeploymentWorkflowCanvas from "./DeploymentWorkflowCanvas.vue";
import { analyzeWorkflowGraph, connectWorkflowNodes, groupWorkflowStep, moveWorkflowStep, normalizeGraphWorkflow, rebuildWorkflowEdges, removeWorkflowEdge, setWorkflowPosition, toggleWorkflowStep, withWorkflowCanvas, workflowGraphLayout, workflowIssues, workflowRounds, type DeploymentWorkflow, type DeploymentWorkflowState, type WorkflowPoint } from "~/utils/deploymentWorkflow";

const { api } = useApi();
// Keep a draft when navigating between settings sections; never silently discard it.
const state = useState<DeploymentWorkflowState | null>("deployment-workflow-state", () => null);
const draft = useState<DeploymentWorkflow | null>("deployment-workflow-draft", () => null);
const selectedId = ref("identify_modpack");
const selectedEdgeId = ref("");
const canvasEditor = ref<InstanceType<typeof DeploymentWorkflowCanvas> | null>(null);
const undoStack = ref<string[]>([]), redoStack = ref<string[]>([]);
let restoringHistory = false;
const loading = ref(false), saving = ref(false), error = ref(""), notice = ref("");
const preview = ref<{ prompt: string; effectivePrompt: string } | null>(null);
const previewBusy = ref(false), previewError = ref("");
const previewMode = ref<"workflow" | "system">("workflow");
const copied = ref(false);
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewSerial = 0;
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== JSON.stringify(state.value ? withWorkflowCanvas(state.value.workflow) : null));
const workspaceDirty = useState<boolean>("deployment-workflow-dirty", () => false);
watch(dirty, (value) => { workspaceDirty.value = value; }, { immediate: true });
const issues = computed(() => draft.value && state.value ? workflowIssues(draft.value, state.value.catalog) : []);
const graphCheck = computed(() => draft.value ? analyzeWorkflowGraph(draft.value) : { rounds: [], issues: [] });
const invalidNodes = computed(() => [...new Set([...graphCheck.value.issues.flatMap(issue => issue.nodeIds), ...(draft.value?.steps.filter(step => issues.value.some(issue => issue.includes(`「${step.label}」`))).map(step => step.id) ?? [])])]);
const invalidEdges = computed(() => graphCheck.value.issues.flatMap(issue => issue.edgeIds));
const selectedEdge = computed(() => draft.value?.canvas?.edges.find(edge => edge.id === selectedEdgeId.value));
const selected = computed(() => draft.value?.steps.find((step) => step.id === selectedId.value));
const selectedIndex = computed(() => draft.value?.steps.findIndex((step) => step.id === selectedId.value) ?? -1);
const builtIn = computed(() => state.value?.catalog.find((step) => step.id === selectedId.value));
const rounds = computed(() => workflowRounds(draft.value ? normalizeGraphWorkflow(draft.value).steps : []));
const selectedRound = computed(() => rounds.value.findIndex((round) => round.steps.some((step) => step.id === selectedId.value)));
const editingRounds = computed(() => workflowRounds(draft.value ? normalizeGraphWorkflow(draft.value).steps : [], true));
const editingRoundIndex = computed(() => editingRounds.value.findIndex(round => round.steps.some(step => step.id === selectedId.value)));
const parallelTargets = computed(() => rounds.value.filter((round) => round.steps.every((step) => !["identify_modpack", "final_mcdr_test", selectedId.value].includes(step.id)) && round.id !== selected.value?.parallelGroup));
const promptText = computed(() => previewMode.value === "system" ? preview.value?.effectivePrompt ?? "" : preview.value?.prompt ?? "");
const promptUnavailable = computed(() => !!issues.value.length || previewBusy.value || !!previewError.value || !preview.value);

async function load() {
  if (dirty.value) { error.value = "有未保存的编排。请先保存或撤销，再刷新。"; return; }
  loading.value = true; error.value = "";
  try {
    state.value = await api<DeploymentWorkflowState>("/api/settings/deployment-workflow");
    restoringHistory = true;
    draft.value = withWorkflowCanvas(structuredClone(toRaw(state.value.workflow)));
    await nextTick(); restoringHistory = false; undoStack.value = []; redoStack.value = [];
  } catch (e: any) { error.value = e.data?.error ?? e.message ?? "无法加载流程"; }
  finally { loading.value = false; }
}
async function refreshPreview() {
  const serial = ++previewSerial;
  if (!draft.value || issues.value.length) { previewBusy.value = false; return; }
  previewBusy.value = true; previewError.value = "";
  try {
    const result = await api<{ prompt: string; effectivePrompt: string }>("/api/settings/deployment-workflow/preview", { method: "POST", body: { workflow: draft.value } });
    if (serial === previewSerial) preview.value = result;
  } catch (e: any) { if (serial === previewSerial) previewError.value = e.data?.error ?? e.message; }
  finally { if (serial === previewSerial) previewBusy.value = false; }
}
watch(draft, () => {
  notice.value = ""; copied.value = false; previewError.value = "";
  ++previewSerial; clearTimeout(previewTimer);
  if (!draft.value || issues.value.length) { previewBusy.value = false; return; }
  previewBusy.value = true;
  previewTimer = setTimeout(() => void refreshPreview(), 250);
}, { deep: true, immediate: true });
watch(() => JSON.stringify(draft.value), (next, previous) => {
  if (restoringHistory || !previous || previous === "null" || next === previous) return;
  undoStack.value = [...undoStack.value.slice(-59), previous]; redoStack.value = [];
});
function change(next: DeploymentWorkflow) { draft.value = normalizeGraphWorkflow(next); error.value = ""; }
async function checkWorkflow() {
  if (!issues.value.length) await refreshPreview();
}
async function history(direction: "undo" | "redo") {
  if (!draft.value || saving.value) return;
  const source = direction === "undo" ? undoStack : redoStack, target = direction === "undo" ? redoStack : undoStack;
  const entry = source.value.at(-1); if (!entry) return;
  target.value.push(JSON.stringify(draft.value)); source.value.pop(); restoringHistory = true;
  draft.value = JSON.parse(entry); selectedEdgeId.value = "";
  await nextTick(); restoringHistory = false;
}
function movePosition(id: string, point: WorkflowPoint) { if (draft.value && !saving.value) change(setWorkflowPosition(draft.value, id, point)); }
function connect(from: string, to: string) { if (draft.value && !saving.value) change(connectWorkflowNodes(draft.value, from, to)); }
function deleteEdge(id: string) { if (draft.value && !saving.value) { change(removeWorkflowEdge(draft.value, id)); selectedEdgeId.value = ""; } }
function toggleStep(id: string) {
  if (!draft.value || saving.value || state.value?.catalog.some((step) => step.id === id)) return;
  change(toggleWorkflowStep(draft.value, id));
}
async function arrange() {
  if (!draft.value || saving.value) return;
  const next = withWorkflowCanvas(draft.value); change({ ...next, canvas: { ...next.canvas, positions: workflowGraphLayout(next) } });
  await nextTick(); canvasEditor.value?.fit();
}
function editorKey(event: KeyboardEvent) {
  if ((event.target as Element).closest("input, textarea, select") || !(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y") { event.preventDefault(); void history(event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo"); }
}
function reorder(id: string, direction: -1 | 1) {
  if (!draft.value || !state.value || saving.value) return;
  const current = editingRounds.value.findIndex(round => round.steps.some(step => step.id === id));
  const target = editingRounds.value[current + direction];
  if (!target) return;
  const index = draft.value.steps.findIndex(step => step.id === (direction < 0 ? target.steps[0]!.id : target.steps.at(-1)!.id));
  const next = moveWorkflowStep(draft.value, id, index);
  change(next);
  select(id);
  notice.value = `已调整「${next.steps.find((step) => step.id === id)?.label}」的顺序，保存后生效。`;
}
function add() {
  if (!draft.value || draft.value.steps.length >= 40) return;
  const id = `custom_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const index = Math.max(1, draft.value.steps.length - 1);
  const next = withWorkflowCanvas(structuredClone(toRaw(draft.value)));
  const lastPosition = next.canvas.positions[next.steps[index]!.id]!;
  next.steps.splice(index, 0, { id, label: "自定义步骤", prompt: "", enabled: true });
  next.canvas.positions[id] = { x: lastPosition.x + 350, y: lastPosition.y - 70 };
  change(analyzeWorkflowGraph(draft.value).issues.length ? next : rebuildWorkflowEdges(next));
  select(id);
}
function group(id: string, targetId: string | null) {
  if (!draft.value || !state.value || saving.value) return;
  const next = groupWorkflowStep(draft.value, id, targetId);
  change(next);
  notice.value = targetId ? "已加入并行组：同一 turn 分叉执行，所有分支完成后汇合。" : "已拆为独立 turn。";
}
function select(id: string) { selectedId.value = id; selectedEdgeId.value = ""; }
function remove() {
  if (!draft.value || builtIn.value) return;
  const next = withWorkflowCanvas(structuredClone(toRaw(draft.value)));
  next.steps = next.steps.filter((step) => step.id !== selectedId.value);
  next.canvas.edges = next.canvas.edges.filter(edge => edge.from !== selectedId.value && edge.to !== selectedId.value);
  delete next.canvas.positions[selectedId.value];
  change(next);
  selectedId.value = draft.value.steps[0]!.id;
}
function revert() {
  if (state.value) draft.value = withWorkflowCanvas(structuredClone(toRaw(state.value.workflow)));
  error.value = ""; selectedEdgeId.value = "";
}
function defaults() {
  if (state.value) draft.value = withWorkflowCanvas(structuredClone(toRaw(state.value.defaults)));
  error.value = ""; selectedEdgeId.value = ""; selectedId.value = "identify_modpack";
}
async function save() {
  if (!draft.value || saving.value) return;
  if (issues.value.length) return;
  saving.value = true; error.value = "";
  try {
    state.value = await api<DeploymentWorkflowState>("/api/settings/deployment-workflow", { method: "PUT", body: draft.value });
    restoringHistory = true; draft.value = withWorkflowCanvas(structuredClone(toRaw(state.value.workflow)));
    await nextTick(); restoringHistory = false;
    await nextTick(); notice.value = "流程已保存。下一次 Agent 任务开始时生效；正在运行的任务保持原流程。";
  } catch (e: any) { error.value = e.data?.error ?? e.message; }
  finally { saving.value = false; }
}
async function copyPrompt() {
  try { await navigator.clipboard.writeText(promptText.value); copied.value = true; }
  catch { previewError.value = "复制失败，请在预览中选中文本复制。"; }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = ""; } }
onMounted(() => { if (!state.value) void load(); window.addEventListener("beforeunload", beforeUnload); });
onBeforeUnmount(() => { clearTimeout(previewTimer); ++previewSerial; window.removeEventListener("beforeunload", beforeUnload); });
defineExpose({ refresh: load });
</script>

<template>
  <div class="workflow-editor" @keydown="editorKey">
    <AsyncPlaceholder v-if="loading && !state" variant="form" label="正在加载部署流程" :rows="4" />
    <div v-if="error" class="settings-warning-note workflow-error" role="alert"><AppIcon name="warning" /><span>{{ error }}</span><button v-if="!state" type="button" @click="load">重试</button></div>
    <template v-if="state && draft">
       <div class="workflow-toolbar"><div><span class="settings-badge">全局流程</span><strong>{{ draft.steps.filter(s => s.enabled).length }} 个执行步骤 · {{ issues.length ? '待修正' : `${rounds.length} 个 turn` }}</strong><span class="workflow-draft-state" :class="{ dirty }">{{ dirty ? '未保存的更改' : '已与配置同步' }}</span></div><div><button type="button" :disabled="saving || !undoStack.length" aria-label="撤销上次编排操作" @click="history('undo')"><AppIcon name="arrowLeft" />撤销</button><button type="button" :disabled="saving || !redoStack.length" aria-label="重做编排操作" @click="history('redo')"><AppIcon name="arrowRight" />重做</button><button type="button" :disabled="saving || draft.steps.length >= 40" @click="add"><AppIcon name="plus" />添加步骤</button><button type="button" :disabled="saving" @click="defaults"><AppIcon name="history" />默认编排</button></div></div>
       <p class="settings-info-note"><AppIcon name="info" />新建服务端会自动套用 MCDReforged 模板，不占用流程步骤；Java 版本依赖在安装 Loader 前单独检查。</p>
      <p class="settings-info-note"><AppIcon name="workflow" />每个节点独占一个 turn，并行组共用一个 turn。所有分支与后台任务完成并汇合后，系统才自动进入下一轮；失败或中断不会跳过。</p>
        <div class="workflow-validation" :class="{ invalid: issues.length }" aria-live="polite" data-workflow-validation>
          <div><AppIcon :name="issues.length ? 'warning' : 'check'" /><strong>{{ issues.length ? `${issues.length} 项问题 · 草稿已保留` : '检查通过' }}</strong><button type="button" :disabled="saving" @click="checkWorkflow">检查流程</button></div>
        <ul v-if="issues.length"><li v-for="(issue, index) in issues" :key="`${index}-${issue}`">{{ issue }}</li></ul>
      </div>
      <div class="workflow-workbench">
          <DeploymentWorkflowCanvas ref="canvasEditor" :workflow="draft" :selected="selectedId" :selected-edge="selectedEdgeId" :disabled="saving" :valid="!issues.length" :invalid-nodes="invalidNodes" :invalid-edges="invalidEdges" @select="select" @select-edge="selectedEdgeId = $event" @position="movePosition" @connect="connect" @remove-edge="deleteEdge" @toggle="toggleStep" @arrange="arrange" />
        <aside v-if="selectedEdge" class="workflow-inspector">
          <div class="workflow-inspector-heading"><span class="settings-category-icon"><AppIcon name="workflow" /></span><div><small>有向连接</small><h2>连线设置</h2></div></div>
          <p class="workflow-edge-description">{{ draft.steps.find(step => step.id === selectedEdge!.from)?.label }}<span>↓</span>{{ draft.steps.find(step => step.id === selectedEdge!.to)?.label }}</p>
          <p class="settings-info-note">连线表示前置依赖，可跨轮连接；按依赖分层并发，每轮全部完成后进入下一轮，所有分支最终汇合到唯一出口。</p>
          <button type="button" class="danger" :disabled="saving" @click="deleteEdge(selectedEdge.id)"><AppIcon name="trash" />删除连线</button>
          <button type="button" @click="selectedEdgeId = ''">返回节点设置</button>
        </aside>
        <aside v-else-if="selected" class="workflow-inspector">
          <div class="workflow-inspector-heading"><span class="settings-category-icon"><AppIcon name="workflow" /></span><div><small>步骤 {{ String(selectedIndex + 1).padStart(2, '0') }}</small><h2>步骤设置</h2></div><span class="settings-badge">{{ builtIn ? '内置 · 必需' : '自定义' }}</span></div>
          <fieldset :disabled="saving" class="workflow-fields">
            <label class="settings-field"><span>步骤名称</span><input v-model="selected.label" maxlength="60" aria-label="步骤名称" /></label>
            <div class="workflow-step-id"><code>{{ selected.id }}</code><span>进度上报 ID</span></div>
            <div class="workflow-round-settings">
               <strong>{{ issues.length ? '连线校验未通过 · 暂不分配 turn' : selectedRound < 0 ? '已停用 · 不参与 turn' : `Turn ${selectedRound + 1} · ${selected.parallelGroup ? '并行组 · 全部汇合' : '串行节点'}` }}</strong>
              <small>自由拖动节点；从下方输出点连到上方输入点。也可以依次点选两个连接点，手机同样可用。</small>
              <template v-if="!['identify_modpack', 'final_mcdr_test'].includes(selected.id)">
                 <details v-if="!graphCheck.issues.length" class="workflow-shortcuts"><summary>快捷编排（重建连接关系）</summary><label class="settings-field"><span>与其他节点并行</span><select aria-label="并行目标节点" value="" @change="group(selectedId, ($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''"><option value="" disabled>选择节点 / 并行组…</option><option v-for="round in parallelTargets" :key="round.id" :value="round.steps[0]!.id">{{ round.steps.map(step => step.label).join(' ∥ ') }}</option></select></label><button v-if="selected.parallelGroup" type="button" @click="group(selectedId, null)">拆为独立 turn</button></details>
              </template>
              <small>最多 4 个无依赖节点；仅 background 工具可重叠运行，不允许并发修改同一文件或配置。</small>
            </div>
            <label class="settings-field"><span>Agent 执行指令</span><textarea v-model="selected.prompt" rows="10" maxlength="12000" aria-label="Agent 执行指令" placeholder="告诉 Agent 这一步要做什么、使用哪些工具、如何判断完成…" /><small>这里是给 Agent 的提示词，不会直接执行代码。内置步骤的必要技术检查始终保留。</small></label>
            <label v-if="!builtIn" class="workflow-enable"><input v-model="selected.enabled" type="checkbox" role="switch" />启用此步骤<small>禁用后不组装进 Prompt</small></label>
            <div v-if="builtIn" class="workflow-dependencies"><AppIcon name="shield" /><span>内置必要技术检查始终保留；前置连线与执行轮次可自由调整。</span></div>
            <div class="workflow-step-actions"><button type="button" :disabled="editingRoundIndex <= 0 || !!graphCheck.issues.length" aria-label="上移当前步骤" @click="reorder(selectedId, -1)"><AppIcon name="arrowUp" />提前一轮</button><button type="button" :disabled="editingRoundIndex >= editingRounds.length - 1 || !!graphCheck.issues.length" aria-label="下移当前步骤" @click="reorder(selectedId, 1)"><AppIcon name="arrowDown" />延后一轮</button><button v-if="!builtIn" type="button" class="danger" @click="remove"><AppIcon name="trash" />删除</button></div>
          </fieldset>
        </aside>
      </div>
      <p v-if="notice" class="workflow-notice" role="status"><AppIcon name="check" />{{ notice }}</p>
      <footer class="settings-save-bar workflow-save-bar"><span><AppIcon name="shield" />确认门禁、目录隔离与必要验证不能跳过</span><div class="settings-actions"><button type="button" :disabled="!dirty || saving" @click="revert">撤销更改</button><button type="button" class="primary" :disabled="!dirty || saving || !!issues.length" @click="save"><AppIcon :name="saving ? 'loader' : 'save'" :spin="saving" />{{ saving ? '保存中…' : '保存编排' }}</button></div></footer>
      <section class="workflow-preview settings-surface" :aria-busy="previewBusy">
        <div class="workflow-preview-header"><div><h2>Agent 会看到什么？</h2><p>服务端使用同一个编译器生成，预览不会调用模型或保存草稿。</p></div><button type="button" :disabled="promptUnavailable" @click="copyPrompt"><AppIcon name="copy" />{{ copied ? '已复制' : '复制提示词' }}</button></div>
        <div class="settings-filter-group workflow-preview-tabs" aria-label="提示词预览类型"><button type="button" :aria-pressed="previewMode === 'workflow'" @click="previewMode = 'workflow'">流程提示词</button><button type="button" :aria-pressed="previewMode === 'system'" @click="previewMode = 'system'">完整默认 System Prompt</button></div>
         <p class="settings-info-note"><AppIcon name="info" />{{ previewMode === 'system' ? '包含全局基础 Prompt、已启用 Skill、流程编排和运行时工具/恢复规则。实例若有独立基础 Prompt，会替换全局基础部分；实际目录、内存、上传文件和对话历史另行附加。' : '只组装启用的步骤，执行顺序由连线而不是坐标决定。节点自由移动不会改变顺序。' }}</p>
        <p v-if="previewError" class="settings-warning-note" role="alert">{{ previewError }}<button type="button" @click="refreshPreview">重试预览</button></p>
         <pre class="workflow-prompt-text" :class="{ stale: promptUnavailable }">{{ issues.length ? '请先修正流程后预览。' : promptText || '正在生成提示词…' }}</pre>
         <small class="workflow-preview-meta">{{ previewBusy ? '正在更新草稿预览…' : dirty ? '草稿预览 · 尚未保存，不影响 Agent' : '已保存配置预览' }}<span>{{ promptText.length.toLocaleString() }} 字符</span></small>
      </section>
    </template>
  </div>
</template>

<style>
.workflow-editor { display: grid; gap: 18px; min-width: 0; }
.workflow-toolbar, .workflow-toolbar > div, .workflow-preview-header, .workflow-inspector-heading { display: flex; align-items: center; gap: 12px; }
.workflow-toolbar { justify-content: space-between; flex-wrap: wrap; }
.workflow-toolbar > div { flex-wrap: wrap; }
.workflow-toolbar strong { font-size: 12px; font-weight: 500; }
.workflow-draft-state { color: var(--fg-muted); font-size: 11px; }
.workflow-draft-state.dirty { color: var(--yellow); }
.workflow-workbench { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, .8fr); min-width: 0; background: var(--surface-card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.workflow-canvas-wrap { position: relative; min-width: 0; min-height: 680px; height: var(--workflow-canvas-height, 680px); background: var(--surface-page); }
.workflow-canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; background-image: radial-gradient(var(--border-strong) .75px, transparent .75px); touch-action: none; user-select: none; cursor: grab; }
.workflow-canvas:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
.workflow-canvas.dragging, .workflow-canvas.dragging .workflow-node { cursor: grabbing; }
.workflow-canvas-caption { position: absolute; z-index: 1; top: 16px; left: 16px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--fg-secondary); font-size: 11px; pointer-events: none; }
.workflow-canvas-caption > span:last-child { color: var(--fg-muted); }
.workflow-live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.workflow-edge { fill: none; stroke: var(--accent); stroke-width: 1.8; opacity: .7; pointer-events: none; }
.workflow-edge-hit { fill: none; stroke: transparent; stroke-width: 18; pointer-events: stroke; cursor: pointer; }
.workflow-edge-group { outline: none; }
.workflow-edge-group:hover .workflow-edge, .workflow-edge-group:focus-visible .workflow-edge, .workflow-edge-group.selected .workflow-edge { opacity: 1; stroke-width: 3; }
.workflow-edge-group.invalid .workflow-edge { stroke: var(--yellow); stroke-dasharray: 7 4; }
.workflow-edge-draft { stroke-dasharray: 7 5; opacity: 1; }
.workflow-node.invalid .workflow-node-surface { stroke: var(--yellow); stroke-width: 2; }
.workflow-node.floating { filter: drop-shadow(0 5px 10px #0002); }
.workflow-group-decoration { pointer-events: none; }
.workflow-validation { display: grid; gap: 8px; padding: 14px 16px; border-radius: 10px; background: color-mix(in srgb, var(--green) 7%, var(--surface-card)); color: var(--fg-secondary); }
.workflow-validation > div { display: flex; align-items: center; gap: 8px; }
.workflow-validation strong { font-size: 12px; font-weight: 500; flex: 1; }
.workflow-validation small { color: var(--fg-muted); font-size: 11px; }
.workflow-validation .app-icon { color: var(--green); flex: none; }
.workflow-validation.invalid { background: color-mix(in srgb, var(--yellow) 8%, var(--surface-card)); }
.workflow-validation.invalid .app-icon { color: var(--yellow); }
.workflow-validation ul { padding: 0 0 0 18px; margin: 4px 0 0; font-size: 11px; line-height: 1.9; max-height: 160px; overflow: auto; }
.workflow-validation button { flex: none; }
.workflow-node { cursor: grab; outline: none; }
.workflow-node-surface { fill: var(--surface-card); stroke: var(--border-strong); stroke-width: 1; }
.workflow-node:hover .workflow-node-surface, .workflow-node:focus-visible .workflow-node-surface, .workflow-node.selected .workflow-node-surface { stroke: var(--accent); stroke-width: 2; }
.workflow-node.selected .workflow-node-surface { fill: color-mix(in srgb, var(--accent) 8%, var(--surface-card)); }
.workflow-node.inactive { opacity: .5; }
.workflow-node-number-bg { fill: var(--accent-soft); }
.workflow-node-number { fill: var(--accent); font-size: 14px; font-family: monospace !important; }
.workflow-node-name { fill: var(--fg); font-size: 15px; font-weight: 600; pointer-events: none; }
.workflow-node-detail { fill: var(--fg-muted); font-size: 11px; pointer-events: none; }
.workflow-node-grip { stroke: var(--fg-faint); stroke-width: 3; stroke-linecap: round; }
.workflow-node-toggle { cursor: pointer; outline: none; }
.workflow-node-toggle rect { fill: var(--accent-soft); stroke: var(--accent); stroke-width: .8; }
.workflow-node-toggle text { fill: var(--accent); font-size: 10px; font-weight: 600; pointer-events: none; }
.workflow-node-toggle:hover rect, .workflow-node-toggle:focus-visible rect { fill: var(--accent); }
.workflow-node-toggle:hover text, .workflow-node-toggle:focus-visible text { fill: var(--surface-card); }
.workflow-node-toggle[aria-disabled="true"] { cursor: not-allowed; opacity: .55; }
.workflow-port { fill: var(--surface-card); stroke: var(--accent); stroke-width: 2; pointer-events: none; }
.workflow-port-target { cursor: crosshair; outline: none; }
.workflow-port-hit { fill: transparent; }
.workflow-port-target:hover .workflow-port, .workflow-port-target:focus-visible .workflow-port, .workflow-port-target.active .workflow-port, .workflow-port-target.hovered .workflow-port { fill: var(--accent); stroke-width: 3; }
.workflow-canvas.connecting { cursor: crosshair; }
.workflow-connection-hint { position: absolute; left: 16px; right: 16px; top: 45px; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 8px; background: var(--surface-card); color: var(--accent); font-size: 11px; }
.workflow-connection-hint button { margin-left: auto; }
.workflow-edge-description { display: grid; justify-items: center; gap: 16px; padding: 20px; background: var(--surface-soft); border-radius: 10px; font-size: 12px; overflow-wrap: anywhere; }
.workflow-canvas-tools { position: absolute; bottom: 43px; left: 16px; display: flex; align-items: center; gap: 2px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-card); padding: 3px; }
.settings-theme .workflow-canvas-tools button { min-height: 28px; padding: 4px 10px; border: 0; background: transparent; box-shadow: none; }
.workflow-canvas-tools output { width: 42px; text-align: center; font-size: 11px; color: var(--fg-muted); }
.workflow-canvas-help { position: absolute; left: 16px; right: 12px; bottom: 10px; margin: 0; color: var(--fg-muted); font-size: 10px; pointer-events: none; }
.workflow-inspector { display: flex; flex-direction: column; gap: 22px; min-width: 0; padding: 22px; border-left: 1px solid var(--border); }
.workflow-inspector-heading > div { flex: 1; }
.workflow-inspector h2, .workflow-preview h2 { margin: 0; color: var(--fg); font-size: 14px; font-weight: 600; }
.workflow-inspector-heading small { color: var(--fg-muted); font-size: 10px; }
.workflow-fields { display: grid; gap: 16px; padding: 0; margin: 0; border: 0; min-width: 0; }
.settings-theme .workflow-fields textarea { width: 100%; resize: vertical; min-height: 210px; font-size: 12px; line-height: 1.8; }
.workflow-step-id { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: -9px; color: var(--fg-faint); font-size: 10px; overflow-wrap: anywhere; }
.workflow-step-id code { color: var(--accent); font-size: 10px; }
.workflow-step-id > span { flex: none; }
.workflow-round-settings { display: grid; gap: 10px; padding: 14px; background: var(--surface-soft); border-radius: 8px; font-size: 11px; }
.workflow-round-settings strong { color: var(--accent); font-weight: 500; }
.workflow-round-settings small { color: var(--fg-muted); line-height: 1.7; }
.workflow-group-surface { fill: color-mix(in srgb, var(--accent) 4%, transparent); }
.workflow-join-label { fill: var(--accent); font-size: 11px; }
.workflow-shortcuts summary { cursor: pointer; color: var(--fg-muted); padding-block: 6px; }
.workflow-shortcuts[open] { display: grid; gap: 10px; }
.workflow-dependencies { display: flex; gap: 7px; align-items: flex-start; padding: 12px; background: var(--surface-soft); border-radius: 8px; color: var(--fg-muted); font-size: 10px; }
.workflow-dependencies .app-icon { flex: none; --icon-size: 14px; margin-top: 2px; }
.workflow-step-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.workflow-step-actions button { flex: 1; }
.workflow-enable { display: flex; gap: 8px; align-items: center; color: var(--fg-secondary); font-size: 12px; }
.workflow-enable input { accent-color: var(--accent); }
.workflow-enable small { color: var(--fg-muted); font-size: 10px; }
.workflow-notice { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--green); font-size: 12px; }
.workflow-error { align-items: center; }
.workflow-error > div { flex: 1; }
.workflow-error small { display: block; margin-top: 4px; opacity: .8; }
.workflow-error > button { flex: none; margin-left: auto; }
.workflow-editor .settings-warning-note ul { padding-left: 18px; margin: 6px 0 0; }
.workflow-editor .workflow-save-bar { margin-bottom: 8px; }
.workflow-preview { gap: 16px; }
.workflow-preview-header { justify-content: space-between; align-items: flex-start; }
.workflow-preview-header p { margin: 5px 0 0; color: var(--fg-muted); font-size: 11px; }
.workflow-preview-header button { flex: none; }
.workflow-preview-tabs { width: fit-content; max-width: 100%; }
.workflow-prompt-text { max-height: 400px; min-height: 120px; margin: 0; padding: 18px; background: var(--surface-code); border-radius: 8px; color: var(--fg-secondary); white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto; font-size: 11px; line-height: 1.9; }
.workflow-prompt-text.stale { opacity: .5; }
.workflow-preview-meta { display: flex; gap: 8px; justify-content: space-between; color: var(--fg-muted); font-size: 10px; }
@media (max-width: 1100px) { .workflow-workbench { grid-template-columns: minmax(0, 1fr) minmax(240px, .95fr); } .workflow-inspector { padding: 16px; } }
@media (max-width: 680px) { .workflow-workbench { grid-template-columns: minmax(0, 1fr); } .workflow-canvas-wrap { height: 680px; } .workflow-inspector { border-left: 0; border-top: 1px solid var(--border); } .workflow-toolbar > div { gap: 8px; } .workflow-preview-header { flex-wrap: wrap; } .workflow-preview-tabs button { padding-inline: 7px !important; font-size: 10px !important; } .workflow-save-bar { flex-wrap: wrap; } .workflow-preview.settings-surface { padding: 16px; } }
</style>

<script setup lang="ts">
import MapRegionViewport from "~/components/maps/MapRegionViewport.vue";
import type {
  MapChunkPreview,
  MapMutationPlan,
  MapMutationSelection,
  MapSnapshot,
  MapWorldDirectory,
  MapWorldDiscovery,
  McaHeaderChunk,
  McaHeaderScan,
  McaRegionFile,
  McaRegionPage,
  ServerRecord
} from "~/types/app";

const props = defineProps<{ server: ServerRecord }>();
const emit = defineEmits<{ close: [] }>();
const { api, downloadUrl } = useApi();

const worlds = ref<MapWorldDirectory[]>([]);
const regions = ref<McaRegionFile[]>([]);
const snapshots = ref<MapSnapshot[]>([]);
const selectedWorldId = ref("");
const selectedRegionPath = ref("");
const selectedChunkKey = ref("");
const selectedChunks = ref(new Set<string>());
const header = ref<McaHeaderScan | null>(null);
const preview = ref<MapChunkPreview | null>(null);
const plan = ref<MapMutationPlan | null>(null);
/** The exact selection the displayed plan and confirmation phrase were generated for. */
const plannedSelection = ref<MapMutationSelection | null>(null);
const error = ref("");
const notice = ref("");
const loadingWorlds = ref(true);
const loadingRegions = ref(false);
const loadingHeader = ref(false);
const loadingPreview = ref(false);
const loadingSnapshots = ref(false);
const operating = ref(false);
const snapshotDrawerOpen = ref(false);
const dangerOpen = ref(false);
const mutationMode = ref<MapMutationSelection["mode"]>("chunks");
const rectangle = reactive({ minX: 0, minZ: 0, maxX: 0, maxZ: 0 });
const confirmationPhrase = ref("");
const snapshotName = ref("");
const snapshotDescription = ref("");
const snapshotPhrases = ref<Record<string, { rollback: string; remove: string }>>({});
const regionOffset = ref(0);
const regionTotal = ref(0);
const discoveryTruncated = ref(false);
const dialog = ref<HTMLElement | null>(null);
const dangerCard = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const confirmationInput = ref<HTMLInputElement | null>(null);
let regionRequest = 0;
let headerRequest = 0;
let previewRequest = 0;
let planRequest = 0;
let worldRequest = 0;
let snapshotRequest = 0;

const selectedWorld = computed(() => worlds.value.find((world) => world.id === selectedWorldId.value) ?? null);
const selectedWorldIndex = computed(() => worlds.value.findIndex((world) => world.id === selectedWorldId.value));
const selectedRegion = computed(() => regions.value.find((region) => region.path === selectedRegionPath.value) ?? null);

const selectedChunkArray = computed(() => [...selectedChunks.value]
  .map((key) => {
    const [localX = 0, localZ = 0] = key.split(":").map(Number);
    return { localX, localZ };
  })
  .sort((a, b) => a.localZ - b.localZ || a.localX - b.localX));

/** Inclusive rectangle with the corners ordered, so an inverted drag still selects an area. */
const normalizedRectangle = computed(() => ({
  minX: Math.min(clampLocal(rectangle.minX), clampLocal(rectangle.maxX)),
  minZ: Math.min(clampLocal(rectangle.minZ), clampLocal(rectangle.maxZ)),
  maxX: Math.max(clampLocal(rectangle.minX), clampLocal(rectangle.maxX)),
  maxZ: Math.max(clampLocal(rectangle.minZ), clampLocal(rectangle.maxZ))
}));

const selectionCount = computed(() => {
  if (mutationMode.value === "region") return null;
  if (mutationMode.value === "rectangle") {
    const box = normalizedRectangle.value;
    return (box.maxX - box.minX + 1) * (box.maxZ - box.minZ + 1);
  }
  return selectedChunks.value.size;
});

const serverStopped = computed(() => props.server.status === "stopped");
const gateReason = computed(() => {
  if (!serverStopped.value) return `服务端当前状态为“${props.server.status}”。高危地图操作要求状态严格为“stopped”。`;
  if (!selectedRegion.value) return "请先选择一个 MCA 区域文件。";
  if (mutationMode.value !== "region" && !selectionCount.value) return "请先选择至少一个区块。";
  return "";
});
const canPlan = computed(() => !gateReason.value && !operating.value);

/** Identity of the current selection; any change invalidates an already generated plan. */
const selectionSignature = computed(() => JSON.stringify({
  region: selectedRegion.value?.path ?? "",
  regionPath: selectedWorld.value?.regionPath ?? "",
  mode: mutationMode.value,
  chunks: mutationMode.value === "chunks" ? selectedChunkArray.value : [],
  rectangle: mutationMode.value === "rectangle" ? normalizedRectangle.value : null
}));

const previewHeightRange = computed(() => {
  if (!preview.value?.cells.length) return { min: 0, max: 1 };
  const heights = preview.value.cells.map((cell) => cell.height);
  return { min: Math.min(...heights), max: Math.max(...heights) };
});

/** Single always-mounted live region; `v-if` regions are unreliable for announcements. */
const liveStatus = computed(() => {
  if (loadingWorlds.value) return "正在检测世界存档目录";
  if (loadingRegions.value) return "正在读取区域列表";
  if (loadingHeader.value) return "正在读取 MCA 文件头";
  if (loadingPreview.value) return "正在解析区块 NBT";
  if (loadingSnapshots.value) return "正在读取快照列表";
  if (operating.value) return "正在执行高危地图操作";
  if (header.value) return `已加载 ${header.value.region.occupiedChunkCount} 个已占用区块，其中 ${header.value.region.invalidChunkCount} 个分配异常`;
  return "";
});

function clampLocal(value: number) {
  return Number.isFinite(value) ? Math.min(31, Math.max(0, Math.trunc(value))) : 0;
}

function phrasesFor(snapshotId: string) {
  return snapshotPhrases.value[snapshotId] ?? { rollback: "", remove: "" };
}

function setPhrase(snapshotId: string, field: "rollback" | "remove", value: string) {
  snapshotPhrases.value = { ...snapshotPhrases.value, [snapshotId]: { ...phrasesFor(snapshotId), [field]: value } };
}

function discardPlan(reason = "") {
  const wasOpen = dangerOpen.value;
  if (!plan.value && !wasOpen) return;
  plan.value = null;
  plannedSelection.value = null;
  confirmationPhrase.value = "";
  dangerOpen.value = false;
  if (reason) notice.value = reason;
  if (wasOpen) void nextTick(() => closeButton.value?.focus());
}

watch(selectionSignature, () => discardPlan(plan.value ? "选择已变化，删除计划与确认词已失效，请重新生成。" : ""));
watch(() => props.server.status, () => discardPlan(plan.value ? "服务端状态已变化，删除计划已失效，请重新生成。" : ""));

onMounted(() => {
  void nextTick(() => closeButton.value?.focus());
  void Promise.all([loadWorlds(), loadSnapshots()]);
});

async function loadWorlds(options: { keepSelection?: boolean } = {}) {
  const request = ++worldRequest;
  const previousWorldId = selectedWorldId.value;
  loadingWorlds.value = true;
  error.value = "";
  try {
    const discovery = await api<MapWorldDiscovery>(`/api/servers/${props.server.id}/map/worlds`);
    if (request !== worldRequest) return;
    worlds.value = discovery.worlds;
    discoveryTruncated.value = discovery.truncated;
    const keep = options.keepSelection && worlds.value.some((world) => world.id === previousWorldId);
    selectedWorldId.value = keep ? previousWorldId : worlds.value[0]?.id ?? "";
    if (selectedWorldId.value) await loadRegions();
  } catch (cause) {
    if (request === worldRequest) error.value = cause instanceof Error ? cause.message : "无法检测 MCA 存档目录";
  } finally {
    if (request === worldRequest) loadingWorlds.value = false;
  }
}

async function loadRegions(offset = 0) {
  const world = selectedWorld.value;
  if (!world) return;
  const request = ++regionRequest;
  loadingRegions.value = true;
  error.value = "";
  regions.value = [];
  resetRegionSelection();
  try {
    const result = await api<McaRegionPage>(`/api/servers/${props.server.id}/map/regions?regionPath=${encodeURIComponent(world.regionPath)}&offset=${offset}&limit=256`);
    if (request !== regionRequest || selectedWorldId.value !== world.id) return;
    regions.value = result.regions;
    regionOffset.value = result.offset;
    regionTotal.value = result.total;
  } catch (cause) {
    if (request === regionRequest) error.value = cause instanceof Error ? cause.message : "无法读取 MCA 区域目录";
  } finally {
    if (request === regionRequest) loadingRegions.value = false;
  }
}

function resetRegionSelection() {
  header.value = null;
  preview.value = null;
  selectedRegionPath.value = "";
  selectedChunkKey.value = "";
  selectedChunks.value = new Set();
  previewRequest += 1;
  headerRequest += 1;
}

async function selectWorld(id: string) {
  if (id === selectedWorldId.value) return;
  selectedWorldId.value = id;
  await loadRegions();
}

async function selectRegion(region: McaRegionFile) {
  resetRegionSelection();
  const request = ++headerRequest;
  selectedRegionPath.value = region.path;
  loadingHeader.value = true;
  error.value = "";
  try {
    const result = await api<McaHeaderScan>(`/api/servers/${props.server.id}/map/header?path=${encodeURIComponent(region.path)}`);
    if (request !== headerRequest || selectedRegionPath.value !== region.path) return;
    header.value = result;
  } catch (cause) {
    if (request === headerRequest) error.value = cause instanceof Error ? cause.message : "无法读取 MCA 区域头";
  } finally {
    if (request === headerRequest) loadingHeader.value = false;
  }
}

function activateViewportRegion(region: McaRegionFile, loadedHeader: McaHeaderScan | null) {
  if (selectedRegionPath.value === region.path) {
    if (loadedHeader) header.value = loadedHeader;
    else if (!loadingHeader.value) void selectRegion(region);
    return;
  }
  if (loadedHeader) {
    resetRegionSelection();
    selectedRegionPath.value = region.path;
    header.value = loadedHeader;
    loadingHeader.value = false;
  } else {
    void selectRegion(region);
  }
}

function inspectViewportChunk(region: McaRegionFile, loadedHeader: McaHeaderScan, chunk: McaHeaderChunk) {
  activateViewportRegion(region, loadedHeader);
  void selectChunk(chunk);
}

function toggleViewportChunk(region: McaRegionFile, loadedHeader: McaHeaderScan, chunk: McaHeaderChunk) {
  activateViewportRegion(region, loadedHeader);
  toggleChunk(chunk);
}

async function selectChunk(chunk: { localX: number; localZ: number }) {
  const regionPath = selectedRegionPath.value;
  if (!regionPath) return;
  const request = ++previewRequest;
  const key = `${chunk.localX}:${chunk.localZ}`;
  selectedChunkKey.value = key;
  preview.value = null;
  loadingPreview.value = true;
  error.value = "";
  try {
    const result = await api<MapChunkPreview>(`/api/servers/${props.server.id}/map/preview?path=${encodeURIComponent(regionPath)}&localX=${chunk.localX}&localZ=${chunk.localZ}`);
    if (request !== previewRequest || selectedRegionPath.value !== regionPath || selectedChunkKey.value !== key) return;
    preview.value = result;
  } catch (cause) {
    if (request !== previewRequest) return;
    error.value = cause instanceof Error ? cause.message : "无法渲染区块预览";
    preview.value = null;
  } finally {
    if (request === previewRequest) loadingPreview.value = false;
  }
}

function toggleChunk(chunk: { localX: number; localZ: number }) {
  const next = new Set(selectedChunks.value);
  const key = `${chunk.localX}:${chunk.localZ}`;
  if (next.has(key)) next.delete(key); else next.add(key);
  selectedChunks.value = next;
  mutationMode.value = "chunks";
}

function currentSelection(): MapMutationSelection | null {
  if (!selectedWorld.value || !selectedRegion.value) return null;
  return {
    regionPath: selectedWorld.value.regionPath,
    regionFilePath: selectedRegion.value.path,
    mode: mutationMode.value,
    chunks: mutationMode.value === "chunks" ? selectedChunkArray.value : undefined,
    rectangle: mutationMode.value === "rectangle" ? { ...normalizedRectangle.value } : undefined
  };
}

async function beginDangerousDelete() {
  const selection = currentSelection();
  if (!selection || !canPlan.value) return;
  const signature = selectionSignature.value;
  const status = props.server.status;
  const request = ++planRequest;
  operating.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await api<MapMutationPlan>(`/api/servers/${props.server.id}/map/plan`, { method: "POST", body: selection });
    // Drop the plan if anything moved while it was in flight; the phrase must describe what is on screen.
    if (request !== planRequest || signature !== selectionSignature.value || status !== props.server.status) {
      notice.value = "选择或服务端状态在生成计划期间发生变化，请重新生成删除计划。";
      return;
    }
    plan.value = result;
    plannedSelection.value = selection;
    confirmationPhrase.value = "";
    snapshotName.value = `删除前快照 ${selectedRegion.value?.name ?? "地图"}`;
    snapshotDescription.value = "地图区块删除前自动创建的受影响文件快照";
    dangerOpen.value = true;
    void nextTick(() => confirmationInput.value?.focus());
  } catch (cause) {
    if (request === planRequest) error.value = cause instanceof Error ? cause.message : "无法生成高危操作计划";
  } finally {
    if (request === planRequest) operating.value = false;
  }
}

async function executeDelete() {
  const frozen = plannedSelection.value;
  const current = plan.value;
  if (!frozen || !current || confirmationPhrase.value !== current.confirmationPhrase) return;
  operating.value = true;
  error.value = "";
  try {
    const result = await api<{ snapshot: MapSnapshot }>(`/api/servers/${props.server.id}/map/delete`, {
      method: "POST",
      body: { ...frozen, confirmationPhrase: confirmationPhrase.value, snapshotName: snapshotName.value, snapshotDescription: snapshotDescription.value }
    });
    dangerOpen.value = false;
    plan.value = null;
    plannedSelection.value = null;
    confirmationPhrase.value = "";
    selectedChunks.value = new Set();
    notice.value = `删除完成，操作前状态已保存为快照 ${result.snapshot.id}，可在快照面板整档回滚。`;
    await Promise.all([loadRegions(regionOffset.value), loadSnapshots()]);
    void nextTick(() => closeButton.value?.focus());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除失败";
  } finally {
    operating.value = false;
  }
}

async function loadSnapshots() {
  const request = ++snapshotRequest;
  loadingSnapshots.value = true;
  try {
    const result = await api<MapSnapshot[]>(`/api/servers/${props.server.id}/map/snapshots`);
    if (request !== snapshotRequest) return;
    snapshots.value = result;
  } catch (cause) {
    if (request === snapshotRequest) error.value = cause instanceof Error ? cause.message : "无法读取快照列表";
  } finally {
    if (request === snapshotRequest) loadingSnapshots.value = false;
  }
}

async function rollback(snapshot: MapSnapshot) {
  if (phrasesFor(snapshot.id).rollback !== snapshot.rollbackConfirmationPhrase || !serverStopped.value) return;
  operating.value = true;
  error.value = "";
  try {
    const result = await api<{ safetySnapshot: MapSnapshot }>(`/api/servers/${props.server.id}/map/snapshots/${snapshot.id}/rollback`, {
      method: "POST",
      body: { confirmationPhrase: phrasesFor(snapshot.id).rollback }
    });
    setPhrase(snapshot.id, "rollback", "");
    notice.value = `回滚完成，回滚前状态已另存为快照 ${result.safetySnapshot.id}。`;
    await Promise.all([loadWorlds({ keepSelection: true }), loadSnapshots()]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "回滚失败";
  } finally {
    operating.value = false;
  }
}

async function removeSnapshot(snapshot: MapSnapshot) {
  if (phrasesFor(snapshot.id).remove !== snapshot.deleteConfirmationPhrase) return;
  operating.value = true;
  error.value = "";
  try {
    await api(`/api/servers/${props.server.id}/map/snapshots/${snapshot.id}`, {
      method: "DELETE",
      body: { confirmationPhrase: phrasesFor(snapshot.id).remove }
    });
    setPhrase(snapshot.id, "remove", "");
    notice.value = `快照 ${snapshot.id} 已永久删除。`;
    await loadSnapshots();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除快照失败";
  } finally {
    operating.value = false;
  }
}

function cancelDanger() {
  discardPlan();
}

function handleWorldKeydown(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !worlds.value.length) return;
  event.preventDefault();
  const current = selectedWorldIndex.value;
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? worlds.value.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + worlds.value.length) % worlds.value.length;
  const world = worlds.value[next]!;
  void selectWorld(world.id).then(() => {
    if (selectedWorldId.value === world.id) void nextTick(() => document.getElementById(`map-world-${next}`)?.focus());
  });
}

function focusables(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('button, input, textarea, select, summary, a[href], [tabindex]')]
    .filter((element) => !element.hasAttribute("disabled")
      && element.getAttribute("tabindex") !== "-1"
      && !element.closest("[inert]")
      && element.offsetParent !== null);
}

/** Traps Tab inside the danger overlay while it is open, otherwise inside the dialog. */
function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (dangerOpen.value) { cancelDanger(); return; }
    emit("close");
    return;
  }
  if (event.key !== "Tab") return;
  const container = dangerOpen.value ? dangerCard.value : dialog.value;
  if (!container) return;
  const items = focusables(container);
  if (!items.length) return;
  const first = items[0]!;
  const last = items.at(-1)!;
  const active = document.activeElement as HTMLElement | null;
  if (!active || !container.contains(active)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}
</script>

<template>
  <section
    ref="dialog"
    class="card map-editor-dialog map-workbench"
    role="dialog"
    aria-modal="true"
    aria-labelledby="map-editor-title"
    @keydown="handleKeydown"
  >
    <header class="map-editor-header" :inert="dangerOpen">
      <div>
        <p class="eyebrow">MCA / MAP WORKBENCH</p>
        <h2 id="map-editor-title">地图工作台</h2>
        <p class="map-workbench-subtitle">{{ props.server.name }} · 只读预览 / 受保护变更</p>
      </div>
      <div class="map-workbench-state" :class="{ blocked: !serverStopped }">
        <span class="status-dot" />{{ serverStopped ? "已停止 · 可执行变更" : `${props.server.status} · 变更已锁定` }}
      </div>
      <button ref="closeButton" type="button" class="icon-button" aria-label="关闭地图工作台" @click="emit('close')">×</button>
    </header>

    <div class="map-editor-content map-workbench-content" :inert="dangerOpen">
      <p class="danger-note" role="alert" :hidden="!error">{{ error }}</p>
      <p class="success-note" role="status" :hidden="!notice">{{ notice }}</p>
      <!-- Always mounted so assistive tech observes the region rather than an insertion. -->
      <p class="visually-hidden" role="status">{{ liveStatus }}</p>
      <p class="map-editor-intro">服务端在 Linux 上读取实际 MCA 文件并在后端解析 NBT，预览只返回 16×16 顶部高度与材质采样。删除与回滚都在停服状态下执行，并先把受影响文件写入服务器目录之外的快照。</p>

      <template v-if="loadingWorlds">
        <p class="muted">正在检测世界存档目录...</p>
      </template>
      <template v-else-if="!worlds.length">
        <p class="map-editor-note">未找到可读取的 MCA 区域目录。</p>
      </template>
      <template v-else>
        <p v-if="discoveryTruncated" class="danger-note">目录扫描达到安全上限，结果可能不完整。</p>
        <div class="map-world-tabs" role="tablist" aria-label="世界维度" @keydown="handleWorldKeydown">
          <button
            v-for="(world, index) in worlds"
            :id="`map-world-${index}`"
            :key="world.id"
            type="button"
            role="tab"
            :aria-controls="'map-region-panel'"
            :aria-selected="selectedWorldId === world.id"
            :tabindex="selectedWorldId === world.id ? 0 : -1"
            :class="{ active: selectedWorldId === world.id }"
            @click="void selectWorld(world.id)"
          >{{ world.label }}</button>
        </div>

        <div
          id="map-region-panel"
          class="map-workbench-main"
          role="tabpanel"
          :aria-labelledby="`map-world-${selectedWorldIndex}`"
        >
          <section class="map-workbench-preview">
            <div class="map-region-heading"><span>区域文件</span><code>{{ selectedWorld?.regionPath }}</code></div>
            <p v-if="loadingRegions" class="muted">正在读取区域列表...</p>
            <p v-else-if="!regions.length" class="map-editor-note">当前页面没有可读取的区域文件。</p>
            <MapRegionViewport
              v-else
              :server-id="props.server.id"
              :regions="regions"
              :region-total="regionTotal"
              :selected-region-path="selectedRegionPath"
              :selected-header="header"
              :loading-selected-header="loadingHeader"
              :selected-chunk-key="selectedChunkKey"
              :selected-chunks="selectedChunks"
              :mutation-mode="mutationMode"
              :rectangle="rectangle"
              @select-region="activateViewportRegion"
              @inspect-chunk="inspectViewportChunk"
              @toggle-chunk="toggleViewportChunk"
            />
            <div v-if="regionTotal > 256" class="map-pagination">
              <span>显示 {{ regionOffset + 1 }}–{{ Math.min(regionOffset + regions.length, regionTotal) }} / {{ regionTotal }}</span>
              <button type="button" :disabled="regionOffset === 0" @click="void loadRegions(Math.max(0, regionOffset - 256))">上一页</button>
              <button type="button" :disabled="regionOffset + regions.length >= regionTotal" @click="void loadRegions(regionOffset + 256)">下一页</button>
            </div>

            <div v-if="selectedRegion" class="map-header-summary">
              <div class="map-region-heading">
                <span>{{ selectedRegion.name }} · {{ header?.region.occupiedChunkCount ?? 0 }} 个已占用区块</span>
                <code>{{ selectedRegion.size.toLocaleString() }} B</code>
              </div>
              <p v-if="loadingHeader" class="muted">正在读取 8KB MCA 头...</p>
              <template v-else-if="header">
                <p>{{ header.region.invalidChunkCount }} 个分配异常。地图中点击区块预览，Shift + 点击或右键加入删除范围。</p>
                <p class="map-editor-note">下方明细列表提供 44px 触控目标，是地图画布之外的等效操作路径。</p>
                <ul class="map-chunk-list" role="list" aria-label="已占用区块明细">
                  <li v-for="chunk in header.chunks" :key="`detail-${chunk.localX}:${chunk.localZ}`">
                    <button
                      type="button"
                      :class="{ active: selectedChunkKey === `${chunk.localX}:${chunk.localZ}` }"
                      @click="void selectChunk(chunk)"
                    >
                      <code>{{ chunk.chunkX }},{{ chunk.chunkZ }}</code>
                      <span>{{ chunk.valid ? "分配正常" : "分配异常" }}</span>
                    </button>
                    <button
                      type="button"
                      class="text-action"
                      :aria-pressed="selectedChunks.has(`${chunk.localX}:${chunk.localZ}`)"
                      @click="toggleChunk(chunk)"
                    >{{ selectedChunks.has(`${chunk.localX}:${chunk.localZ}`) ? "已选择" : "选择删除" }}</button>
                  </li>
                </ul>
              </template>
            </div>
          </section>

          <aside class="map-operation-rail">
            <div class="map-rail-heading"><span>操作面板</span><strong>高危</strong></div>
            <p class="map-editor-note">任何写入都要求服务端状态为“stopped”，并在执行前把受影响文件写入快照。</p>
            <div class="map-mode-list" role="radiogroup" aria-label="删除范围">
              <label><input v-model="mutationMode" type="radio" value="chunks" />已选择区块 <strong>{{ selectedChunks.size }}</strong></label>
              <label><input v-model="mutationMode" type="radio" value="rectangle" />矩形区域</label>
              <label><input v-model="mutationMode" type="radio" value="region" />整个 MCA 区域</label>
            </div>
            <div v-if="mutationMode === 'rectangle'" class="map-rectangle-fields">
              <label>最小 X <input v-model.number="rectangle.minX" type="number" min="0" max="31" /></label>
              <label>最小 Z <input v-model.number="rectangle.minZ" type="number" min="0" max="31" /></label>
              <label>最大 X <input v-model.number="rectangle.maxX" type="number" min="0" max="31" /></label>
              <label>最大 Z <input v-model.number="rectangle.maxZ" type="number" min="0" max="31" /></label>
              <p class="map-editor-note">生效范围 X {{ normalizedRectangle.minX }}–{{ normalizedRectangle.maxX }} · Z {{ normalizedRectangle.minZ }}–{{ normalizedRectangle.maxZ }}</p>
            </div>
            <p class="map-impact">当前影响：<strong>{{ selectionCount === null ? "整个区域" : `${selectionCount} 个区块` }}</strong></p>
            <p v-if="gateReason" class="map-gate-note" role="status">{{ gateReason }}</p>
            <button type="button" class="danger-button map-danger-button" :disabled="!canPlan" @click="void beginDangerousDelete()">生成删除计划</button>
            <button type="button" class="secondary-button" :aria-expanded="snapshotDrawerOpen" @click="snapshotDrawerOpen = !snapshotDrawerOpen">
              {{ snapshotDrawerOpen ? "收起快照" : "管理快照" }} <span>{{ snapshots.length }}</span>
            </button>
          </aside>
        </div>

        <section v-if="preview || loadingPreview" class="map-preview-panel">
          <div class="map-region-heading">
            <span>区块预览</span>
            <code>{{ preview ? `${preview.chunkX},${preview.chunkZ}` : "读取中" }}</code>
          </div>
          <p v-if="loadingPreview" class="muted">正在解析区块 NBT...</p>
          <template v-else-if="preview">
            <p v-if="preview.unsupportedReason" class="danger-note">{{ preview.unsupportedReason }}</p>
            <div v-else class="map-terrain-preview" role="img" :aria-label="`区块 ${preview.chunkX},${preview.chunkZ} 的 16×16 顶部材质预览`">
              <span
                v-for="cell in preview.cells"
                :key="`${cell.localX}:${cell.localZ}`"
                :style="{ background: cell.color, opacity: 0.55 + ((cell.height - previewHeightRange.min) / Math.max(1, previewHeightRange.max - previewHeightRange.min)) * 0.45 }"
                :title="`${cell.block} · Y=${cell.height}`"
              />
            </div>
            <p v-if="preview.dataVersion" class="map-editor-note">DataVersion <code>{{ preview.dataVersion }}</code></p>
          </template>
        </section>

        <aside v-if="snapshotDrawerOpen" class="map-snapshot-drawer">
          <div class="map-region-heading"><span>快照管理</span><code>{{ snapshots.length }}/20</code></div>
          <p class="map-editor-note">快照保存在服务端目录之外，仅包含受影响文件；被删除的文件也会记录为“缺失”，因此整区删除同样可以回滚。</p>
          <p v-if="loadingSnapshots" class="muted">正在读取快照...</p>
          <p v-else-if="!snapshots.length" class="map-editor-note">暂无快照。删除操作会自动创建快照。</p>
          <template v-else>
            <div v-for="snapshot in snapshots" :key="snapshot.id" class="map-snapshot-item">
              <div>
                <strong>{{ snapshot.name }}</strong>
                <span>{{ new Date(snapshot.createdAt).toLocaleString() }} · {{ snapshot.files.length }} 个文件 · {{ snapshot.reason === "delete" ? "删除前自动" : "手动/回滚前" }}</span>
              </div>
              <details>
                <summary>高危操作</summary>
                <p v-if="!serverStopped" class="map-gate-note">回滚要求服务端状态为“stopped”。</p>
                <code>回滚确认：{{ snapshot.rollbackConfirmationPhrase }}</code>
                <input
                  :value="phrasesFor(snapshot.id).rollback"
                  :aria-label="`快照 ${snapshot.id} 的回滚确认词`"
                  placeholder="输入完整回滚确认词"
                  autocomplete="off"
                  @input="setPhrase(snapshot.id, 'rollback', ($event.target as HTMLInputElement).value)"
                />
                <button
                  type="button"
                  class="warning-button"
                  :disabled="!serverStopped || phrasesFor(snapshot.id).rollback !== snapshot.rollbackConfirmationPhrase || operating"
                  @click="void rollback(snapshot)"
                >整档回滚到该快照</button>
                <code>删除确认：{{ snapshot.deleteConfirmationPhrase }}</code>
                <input
                  :value="phrasesFor(snapshot.id).remove"
                  :aria-label="`快照 ${snapshot.id} 的删除确认词`"
                  placeholder="输入完整删除确认词"
                  autocomplete="off"
                  @input="setPhrase(snapshot.id, 'remove', ($event.target as HTMLInputElement).value)"
                />
                <button
                  type="button"
                  class="danger-button"
                  :disabled="phrasesFor(snapshot.id).remove !== snapshot.deleteConfirmationPhrase || operating"
                  @click="void removeSnapshot(snapshot)"
                >永久删除快照</button>
                <a :href="downloadUrl(`/api/servers/${props.server.id}/map/snapshots/${snapshot.id}/export`)">导出 tar.gz</a>
              </details>
            </div>
          </template>
        </aside>
      </template>
    </div>

    <div v-if="dangerOpen && plan" class="map-danger-overlay" @keydown.stop="handleKeydown">
      <div ref="dangerCard" class="map-danger-card" role="alertdialog" aria-modal="true" aria-labelledby="map-danger-title" aria-describedby="map-danger-detail">
        <p class="eyebrow">不可逆写入 · 第二次确认</p>
        <h3 id="map-danger-title">确认删除 {{ plan.affectedChunkCount === null ? "整个 MCA 区域" : `${plan.affectedChunkCount} 个区块` }}？</h3>
        <p id="map-danger-detail">
          将修改：{{ plan.affectedPaths.join("、") }}。<template v-if="plan.externalChunkFiles.length">同时删除外部区块文件：{{ plan.externalChunkFiles.join("、") }}。</template>
          服务端状态：{{ plan.serverStatus }}。执行前会自动创建快照；失败时会自动回滚到操作前状态。
        </p>
        <label>输入精确确认词 <code>{{ plan.confirmationPhrase }}</code>
          <input ref="confirmationInput" v-model="confirmationPhrase" autocomplete="off" spellcheck="false" />
        </label>
        <label>快照名称 <input v-model="snapshotName" /></label>
        <label>说明 <textarea v-model="snapshotDescription" rows="2" /></label>
        <div class="map-danger-actions">
          <button type="button" @click="cancelDanger">取消</button>
          <button
            type="button"
            class="danger-button"
            :disabled="confirmationPhrase !== plan.confirmationPhrase || operating"
            @click="void executeDelete()"
          >确认删除并创建快照</button>
        </div>
      </div>
    </div>

    <footer class="map-editor-footer" :inert="dangerOpen">
      <span class="map-footer-safety">只读预览 · 停服门禁 · 自动快照 · 精确确认</span>
      <button type="button" @click="emit('close')">关闭</button>
    </footer>
  </section>
</template>

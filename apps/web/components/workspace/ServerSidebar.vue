<script setup lang="ts">
import type { ServerRecord } from "~/types/app";

const props = defineProps<{
  servers: ServerRecord[];
  loading: boolean;
  loaded: boolean;
  selectedServerId: string;
  erroredServerIds: Set<string>;
  settingsOpen: boolean;
  dashboardOpen: boolean;
  backendName: string;
}>();

const emit = defineEmits<{
  create: [];
  "open-dashboard": [];
  "open-instance-menu": [];
  "open-settings": [];
  "open-backends": [];
  logout: [];
  select: [serverId: string];
}>();

const instanceMenuTrigger = ref<HTMLButtonElement | null>(null);
const backendTrigger = ref<HTMLButtonElement | null>(null);
const rail = ref<HTMLElement | null>(null);
const railHead = ref<HTMLElement | null>(null);
const railFooter = ref<HTMLElement | null>(null);
const railActions = ref<HTMLElement | null>(null);
const availableSlots = ref(9);
let resizeObserver: ResizeObserver | undefined;
let measureFrame: number | undefined;

// Dashboard, instance menu, create and settings always have a slot.
const visibleCapacity = computed(() => Math.max(0, availableSlots.value - 4));

const visibleServers = computed(() => {
  const capacity = visibleCapacity.value;
  if (capacity === 0) return [];
  const selectedIndex = props.servers.findIndex((server) => server.id === props.selectedServerId);
  if (selectedIndex < capacity) return props.servers.slice(0, capacity);
  const selectedServer = props.servers.find((server) => server.id === props.selectedServerId);
  return selectedServer ? [...props.servers.slice(0, capacity - 1), selectedServer] : props.servers.slice(0, capacity);
});
const hiddenServerCount = computed(() => Math.max(0, props.servers.length - visibleServers.value.length));

function measureCapacity() {
  if (!rail.value || !railHead.value || !railFooter.value || !railActions.value) return;
  const button = railActions.value.querySelector<HTMLButtonElement>(".rail-button");
  if (!button) return;
  const horizontal = window.matchMedia("(max-width: 820px)").matches;
  const railStyle = getComputedStyle(rail.value);
  const actionsStyle = getComputedStyle(railActions.value);
  const gap = Number.parseFloat(horizontal ? actionsStyle.columnGap : actionsStyle.rowGap) || 0;
  const size = horizontal ? button.offsetWidth : button.offsetHeight;
  const space = horizontal
    ? railActions.value.clientWidth
    : rail.value.clientHeight
      - Number.parseFloat(railStyle.paddingTop)
      - Number.parseFloat(railStyle.paddingBottom)
      - railHead.value.offsetHeight
      - railFooter.value.offsetHeight
      - (Number.parseFloat(railStyle.rowGap) || 0) * 3;
  if (size > 0) availableSlots.value = Math.max(0, Math.floor((space + gap) / (size + gap)));
}

function scheduleMeasure() {
  if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
  measureFrame = requestAnimationFrame(() => { measureFrame = undefined; measureCapacity(); });
}

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleMeasure);
  for (const element of [rail.value, railHead.value, railFooter.value, railActions.value]) {
    if (element) resizeObserver.observe(element);
  }
  window.addEventListener("resize", scheduleMeasure);
  measureCapacity();
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener("resize", scheduleMeasure);
  if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
});

function serverTitle(server: ServerRecord) {
  return props.erroredServerIds.has(server.id) ? `${server.name}（存在报错）` : server.name;
}

defineExpose({
  focusBackendTrigger: () => backendTrigger.value?.focus(),
  focusInstanceMenuTrigger: () => {
    const target = instanceMenuTrigger.value
      ?? railActions.value?.querySelector<HTMLButtonElement>(".rail-server.active")
      ?? railActions.value?.querySelector<HTMLButtonElement>(".rail-dashboard");
    target?.focus();
  }
});
</script>

<template>
  <aside ref="rail" class="sidebar command-rail" aria-label="主导航">
    <div ref="railHead" class="sidebar-head">
      <div class="brand-mark" role="img" aria-label="Minecraft Server Agent"><AppLogo /></div>
    </div>

    <nav ref="railActions" class="rail-actions" aria-label="工作区操作">
      <button class="rail-button rail-dashboard" :class="{ active: props.dashboardOpen }" type="button" title="总面板" aria-label="总面板" :aria-pressed="props.dashboardOpen" @click="emit('open-dashboard')"><AppIcon name="dashboard" /></button>
      <div v-if="props.loading" class="rail-loading" role="status" aria-label="正在加载实例" aria-busy="true"><span v-for="slot in Math.min(3, visibleCapacity)" :key="slot" class="rail-skeleton async-skeleton" aria-hidden="true" /></div>
      <button v-for="server in visibleServers" :key="server.id" class="rail-button rail-server" :class="{ active: server.id === props.selectedServerId && !props.dashboardOpen && !props.settingsOpen }" type="button" :title="serverTitle(server)" :aria-label="serverTitle(server)" @click="emit('select', server.id)">
        {{ server.name.slice(0, 2).toUpperCase() }}
      </button>
      <button ref="instanceMenuTrigger" class="rail-button rail-more" type="button" :title="hiddenServerCount ? `查看另外 ${hiddenServerCount} 个实例` : '查看全部实例'" :aria-label="hiddenServerCount ? `查看另外 ${hiddenServerCount} 个实例` : '查看全部实例'" @click="emit('open-instance-menu')">
        <AppIcon name="instances" />
        <span v-if="hiddenServerCount" class="rail-more-count" aria-hidden="true">{{ hiddenServerCount > 99 ? '99+' : hiddenServerCount }}</span>
      </button>
      <button class="rail-button" type="button" title="创建实例" aria-label="创建实例" @click="emit('create')"><AppIcon name="plus" /></button>
      <button class="rail-button rail-settings" :class="{ active: props.settingsOpen }" type="button" :title="props.settingsOpen ? '返回实例' : '全局设置'" :aria-label="props.settingsOpen ? '返回实例' : '全局设置'" :aria-pressed="props.settingsOpen" @click="emit('open-settings')"><AppIcon name="settings" /></button>
    </nav>

    <div class="rail-spacer" />

    <div ref="railFooter" class="rail-footer">
      <button ref="backendTrigger" class="rail-button rail-backend" type="button" :title="`切换后端实例：${props.backendName}`" :aria-label="`切换后端实例：${props.backendName}`" aria-haspopup="dialog" @click="emit('open-backends')"><AppIcon name="network" /><span class="rail-backend-label">节点</span></button>
      <ThemeToggle class="rail-button rail-theme" />
      <span class="rail-count" :title="props.loading ? '正在加载实例' : props.loaded ? `${props.servers.length} 个实例` : '实例数量尚未读取'">{{ props.loaded ? props.servers.length : '—' }}</span>
      <button class="rail-button rail-logout" type="button" title="退出登录" aria-label="退出登录" @click="emit('logout')">
        <AppIcon name="logout" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.rail-backend { color: var(--blue); gap: 0.1rem; }
.rail-backend-label { font-size: 0.55rem; line-height: 1; letter-spacing: 0; }
@media (max-width: 820px) { .rail-backend-label { display: none; } }
</style>

<script setup lang="ts">
import { withWorkflowCanvas, normalizeGraphWorkflow, workflowRounds, workflowScale, zoomWorkflowCamera, type DeploymentWorkflow, type WorkflowPoint } from "~/utils/deploymentWorkflow";

const props = defineProps<{ workflow: DeploymentWorkflow; selected: string; selectedEdge: string; disabled: boolean; invalidNodes: string[]; invalidEdges: string[]; valid: boolean }>();
const emit = defineEmits<{ select: [id: string]; selectEdge: [id: string]; position: [id: string, point: WorkflowPoint]; connect: [from: string, to: string]; removeEdge: [id: string]; toggle: [id: string]; arrange: []; cancel: [] }>();
const canvas = ref<SVGSVGElement | null>(null);
const camera = reactive({ x: 180, y: 65, scale: 1 });
const width = 304, height = 76;
const stageIds = ["identify_modpack", "prepare_server_slot", "check_java_dependencies", "extract_to_workspace", "install_modloader", "configure_python", "configure_mcdr", "final_mcdr_test"];
const marker = `workflow-arrow-${useId().replaceAll(":", "")}`;
const dragging = ref("");
const floating = reactive({ x: 0, y: 0 });
type Port = "in" | "out";
const connection = ref<{ id: string; port: Port } | null>(null);
const cursor = reactive({ x: 0, y: 0 });
const hoveredPort = ref("");
const pointers = new Map<number, WorkflowPoint>();
let gesture: { type: "node" | "pan" | "link" | "pinch"; id?: string; start: WorkflowPoint; origin: WorkflowPoint; distance?: number; scale?: number; world?: WorkflowPoint } | null = null;
let moved = false, observer: ResizeObserver | undefined;
const graph = computed(() => withWorkflowCanvas(props.workflow));
const rounds = computed(() => workflowRounds(normalizeGraphWorkflow(props.workflow).steps));
const canvasHeight = computed(() => Math.max(680, workflowRounds(normalizeGraphWorkflow(props.workflow).steps, true).length * 146 + 180));
const transform = computed(() => `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
function position(id: string): WorkflowPoint { return dragging.value === id ? floating : graph.value.canvas.positions[id] ?? { x: 0, y: 0 }; }
function portPoint(id: string, port: Port) { const p = position(id); return { x: p.x, y: p.y + (port === "out" ? height / 2 : -height / 2) }; }
function curve(from: WorkflowPoint, to: WorkflowPoint) {
  const bend = Math.max(42, Math.abs(to.y - from.y) * .5);
  return `M${from.x} ${from.y} C${from.x} ${from.y + bend},${to.x} ${to.y - bend},${to.x} ${to.y}`;
}
function edgePath(from: string, to: string) { return curve(portPoint(from, "out"), portPoint(to, "in")); }
const groups = computed(() => props.valid ? rounds.value.filter((round) => round.steps.length > 1).map((round) => {
  const points = round.steps.map((step) => position(step.id));
  const x = Math.min(...points.map((p) => p.x)) - width / 2 - 18, y = Math.min(...points.map((p) => p.y)) - height / 2 - 30;
  return { id: round.id, index: rounds.value.indexOf(round), x, y, width: Math.max(...points.map((p) => p.x)) + width / 2 + 18 - x, height: Math.max(...points.map((p) => p.y)) + height / 2 + 24 - y };
}) : []);
function nodeDetail(id: string) {
  const round = rounds.value.findIndex((item) => item.steps.some((step) => step.id === id));
  if (!props.workflow.steps.find((step) => step.id === id)?.enabled) return "已停用 · 不参与执行";
  return props.valid ? `依赖层 ${round + 1} · ${rounds.value[round]?.steps.length! > 1 ? '并行分支 · 必须汇合' : '独立步骤'}` : "待校验 · 请修正连线";
}
function nodeLabel(label: string) {
  let used = 0, result = "";
  for (const char of label) { used += char.charCodeAt(0) < 128 ? 8 : 15; if (used > 185) return `${result}…`; result += char; }
  return result;
}
function point(event: PointerEvent | WheelEvent) { const rect = canvas.value!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
function world(p: WorkflowPoint) { return { x: (p.x - camera.x) / camera.scale, y: (p.y - camera.y) / camera.scale }; }
function fit() {
  const rect = canvas.value?.getBoundingClientRect();
  if (!rect?.width || !rect.height || !props.workflow.steps.length) return;
  const points = props.workflow.steps.map((step) => position(step.id));
  const minX = Math.min(...points.map((p) => p.x)) - width / 2 - 24, maxX = Math.max(...points.map((p) => p.x)) + width / 2 + 24;
  const minY = Math.min(...points.map((p) => p.y)) - height / 2 - 36, maxY = Math.max(...points.map((p) => p.y)) + height / 2 + 32;
  camera.scale = workflowScale(Math.min(1, (rect.width - 28) / (maxX - minX), (rect.height - 148) / (maxY - minY)));
  camera.x = rect.width / 2 - (minX + maxX) / 2 * camera.scale;
  camera.y = 52 + (rect.height - 148) / 2 - (minY + maxY) / 2 * camera.scale;
}
function zoom(factor: number) { const rect = canvas.value?.getBoundingClientRect(); if (rect) Object.assign(camera, zoomWorkflowCamera(camera, camera.scale * factor, rect.width / 2, rect.height / 2)); }
function cancelConnection() { connection.value = null; hoveredPort.value = ""; }
function toggleStep(id: string) { if (!props.disabled) emit("toggle", id); }
function toggleStepKey(event: KeyboardEvent, id: string) {
  if (!["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  toggleStep(id);
}
function targetPort(p: WorkflowPoint) {
  if (!connection.value) return null;
  const port: Port = connection.value.port === "out" ? "in" : "out";
  return props.workflow.steps.map((step) => ({ id: step.id, port, point: portPoint(step.id, port) }))
    .find((item) => Math.hypot(item.point.x - p.x, item.point.y - p.y) * camera.scale < 24) ?? null;
}
function completeConnection(target: { id: string; port: Port }) {
  if (!connection.value || target.port === connection.value.port || props.disabled) return;
  emit("connect", connection.value.port === "out" ? connection.value.id : target.id, connection.value.port === "out" ? target.id : connection.value.id);
  cancelConnection();
}
function down(event: PointerEvent) {
  if (event.button !== 0 || pointers.size >= 2 || props.disabled) return;
  const element = event.target as Element;
  if (element.closest("[data-workflow-edge]")) { emit("selectEdge", element.closest<SVGElement>("[data-workflow-edge]")!.dataset.workflowEdge!); cancelConnection(); return; }
  event.preventDefault();
  const p = point(event);
  pointers.set(event.pointerId, p); canvas.value?.setPointerCapture(event.pointerId);
  if (pointers.size === 2) {
    dragging.value = ""; cancelConnection();
    const [a, b] = [...pointers.values()] as [WorkflowPoint, WorkflowPoint];
    gesture = { type: "pinch", start: p, origin: p, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: camera.scale, world: world({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) };
    return;
  }
  moved = false;
  let port = element.closest<SVGElement>("[data-workflow-port]");
  const node = element.closest<SVGGElement>("[data-workflow-node]");
  // Chrome may retarget a finger at a nearby port on zoomed-out SVGs. A drag
  // starting in the middle of a node must still move that node, not draw a line.
  if (port && node) {
    const at = world(p), center = portPoint(node.dataset.workflowNode!, port.dataset.workflowPort as Port);
    if (Math.hypot(at.x - center.x, at.y - center.y) > 25) port = null;
  }
  (port ?? node ?? canvas.value)?.focus({ preventScroll: true });
  if (port && node) {
    const target = { id: node.dataset.workflowNode!, port: port.dataset.workflowPort as Port };
    if (connection.value && target.port !== connection.value.port) { completeConnection(target); gesture = null; return; }
    connection.value = target; Object.assign(cursor, world(p));
    gesture = { type: "link", start: p, origin: p }; return;
  }
  if (node) {
    cancelConnection(); const id = node.dataset.workflowNode!; emit("select", id);
    gesture = { type: "node", id, start: p, origin: { ...position(id) } };
  } else {
    cancelConnection(); emit("selectEdge", "");
    gesture = { type: "pan", start: p, origin: { x: camera.x, y: camera.y } };
  }
}
function move(event: PointerEvent) {
  const p = point(event);
  if (connection.value) { Object.assign(cursor, world(p)); hoveredPort.value = targetPort(world(p))?.id ?? ""; }
  if (!pointers.has(event.pointerId) || !gesture) return;
  pointers.set(event.pointerId, p);
  if (gesture.type === "pinch") {
    const [a, b] = [...pointers.values()]; if (!a || !b) return;
    const scale = workflowScale(gesture.scale! * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance!);
    Object.assign(camera, { scale, x: (a.x + b.x) / 2 - gesture.world!.x * scale, y: (a.y + b.y) / 2 - gesture.world!.y * scale }); return;
  }
  const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
  if (!moved && Math.hypot(dx, dy) < 4) return;
  moved = true;
  if (gesture.type === "node") {
    Object.assign(floating, { x: gesture.origin.x + dx / camera.scale, y: gesture.origin.y + dy / camera.scale }); dragging.value = gesture.id!;
  } else if (gesture.type === "pan") Object.assign(camera, { x: gesture.origin.x + dx, y: gesture.origin.y + dy });
}
function up(event: PointerEvent) {
  if (!pointers.delete(event.pointerId)) return;
  const finished = gesture; gesture = null;
  if (event.type === "pointerup" && finished?.type === "node" && moved) emit("position", finished.id!, { ...floating });
  if (finished?.type === "link" && moved) {
    const target = targetPort(world(point(event)));
    if (event.type === "pointerup" && target) completeConnection(target); else cancelConnection();
  }
  if (event.type !== "pointerup") cancelConnection();
  dragging.value = "";
  if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId);
  const first = [...pointers.values()][0];
  if (first) gesture = { type: "pan", start: first, origin: { x: camera.x, y: camera.y } };
}
function wheel(event: WheelEvent) {
  if (pointers.size) return;
  const p = point(event), delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 500 : 1);
  Object.assign(camera, zoomWorkflowCamera(camera, camera.scale * Math.exp(-Math.max(-200, Math.min(200, delta)) * .002), p.x, p.y));
}
function key(event: KeyboardEvent) {
  const element = event.target as Element, id = element.closest<SVGGElement>("[data-workflow-node]")?.dataset.workflowNode;
  const port = element.closest<SVGElement>("[data-workflow-port]")?.dataset.workflowPort as Port | undefined;
  if (event.key === "Escape") { gesture = null; dragging.value = ""; cancelConnection(); emit("selectEdge", ""); emit("cancel"); }
  else if (["Delete", "Backspace"].includes(event.key) && props.selectedEdge && !props.disabled) { event.preventDefault(); emit("removeEdge", props.selectedEdge); }
  else if (id && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    if (port && !props.disabled) {
      if (connection.value && connection.value.port !== port) completeConnection({ id, port });
      else { connection.value = { id, port }; Object.assign(cursor, portPoint(id, port)); }
    } else emit("select", id);
  } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && !props.disabled) {
    event.preventDefault(); const delta = event.shiftKey ? 40 : 10;
    const dx = event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0, dy = event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0;
    if (id) { const p = position(id); emit("position", id, { x: p.x + dx, y: p.y + dy }); } else { camera.x -= dx; camera.y -= dy; }
  } else if (["+", "=", "-", "0"].includes(event.key)) { event.preventDefault(); event.key === "0" ? fit() : zoom(event.key === "-" ? 1 / 1.2 : 1.2); }
}
onMounted(() => { fit(); observer = new ResizeObserver(() => { if (!pointers.size) fit(); }); observer.observe(canvas.value!); });
onBeforeUnmount(() => { observer?.disconnect(); pointers.clear(); });
defineExpose({ fit });
</script>

<template>
  <div class="workflow-canvas-wrap" :style="{ '--workflow-canvas-height': `${canvasHeight}px` }">
    <div class="workflow-canvas-caption"><span class="workflow-live-dot" />自由编排<span>{{ props.workflow.steps.length }} 个节点 · {{ graph.canvas.edges.length }} 条连线</span></div>
    <svg ref="canvas" class="workflow-canvas" :class="{ dragging: !!dragging, connecting: !!connection }" tabindex="0" role="group" aria-label="部署流程画布" aria-describedby="workflow-canvas-help" :style="{ backgroundSize: `${24 * camera.scale}px ${24 * camera.scale}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up" @wheel.prevent="wheel" @keydown="key">
      <defs><marker :id="marker" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--accent)" /></marker></defs>
      <g :transform="transform">
        <g v-for="group in groups" :key="group.id" :data-parallel-group="group.id" class="workflow-group-decoration">
          <rect class="workflow-group-surface" :x="group.x" :y="group.y" :width="group.width" :height="group.height" rx="18" />
          <text class="workflow-join-label" :x="group.x + 14" :y="group.y + 17">依赖层 {{ group.index + 1 }} · 可并行 · 等待分支结果后汇合</text>
        </g>
        <g v-for="edge in graph.canvas.edges" :key="edge.id" :data-workflow-edge="edge.id" class="workflow-edge-group" :class="{ selected: props.selectedEdge === edge.id, invalid: props.invalidEdges.includes(edge.id) }" tabindex="0" role="button" :aria-label="`连线：${props.workflow.steps.find(s => s.id === edge.from)?.label ?? edge.from} → ${props.workflow.steps.find(s => s.id === edge.to)?.label ?? edge.to}`" @click="emit('selectEdge', edge.id)" @keydown.enter.prevent="emit('selectEdge', edge.id)">
          <path class="workflow-edge-hit" :d="edgePath(edge.from, edge.to)" /><path class="workflow-edge" :d="edgePath(edge.from, edge.to)" :marker-end="`url(#${marker})`" />
        </g>
        <path v-if="connection" class="workflow-edge workflow-edge-draft" :d="connection.port === 'out' ? curve(portPoint(connection.id, 'out'), cursor) : curve(cursor, portPoint(connection.id, 'in'))" />
        <g v-for="(step, index) in props.workflow.steps" :key="step.id" :data-workflow-node="step.id" class="workflow-node" :class="{ selected: props.selected === step.id && !props.selectedEdge, inactive: !step.enabled, invalid: props.invalidNodes.includes(step.id), floating: dragging === step.id }" :transform="`translate(${position(step.id).x} ${position(step.id).y})`" tabindex="0" role="button" :aria-label="`${step.label}，方向键移动，回车编辑`" :aria-pressed="props.selected === step.id && !props.selectedEdge" @click="($event as MouseEvent).detail === 0 && emit('select', step.id)">
          <title>{{ step.label }} · 自由拖动，连接点拖拽连线</title>
          <rect class="workflow-node-surface" :x="-width / 2" :y="-height / 2" :width="width" :height="height" rx="12" />
          <rect class="workflow-node-number-bg" x="-136" y="-19" width="38" height="38" rx="10" />
          <text class="workflow-node-number" x="-117" y="5" text-anchor="middle">{{ String(stageIds.includes(step.id) ? stageIds.indexOf(step.id) + 1 : index + 1).padStart(2, '0') }}</text>
          <text class="workflow-node-name" x="-84" y="-4">{{ nodeLabel(step.label) }}</text>
          <text class="workflow-node-detail" x="-84" y="17">{{ nodeDetail(step.id) }}</text>
          <path class="workflow-node-grip" d="M130 -8h.01m0 8h.01m0 8h.01m6-16h.01m0 8h.01m0 8h.01" />
           <g v-if="!stageIds.includes(step.id)" :data-workflow-toggle="step.id" class="workflow-node-toggle" :aria-disabled="props.disabled" :tabindex="props.disabled ? -1 : 0" role="button" :aria-label="`${step.label}${step.enabled ? '关闭' : '启用'}步骤`" @pointerdown.stop @click.stop="toggleStep(step.id)" @keydown.stop="toggleStepKey($event, step.id)">
             <rect x="100" y="-33" width="48" height="20" rx="10" />
             <text x="124" y="-19" text-anchor="middle">{{ step.enabled ? '关闭' : '启用' }}</text>
           </g>
           <g v-for="port in (['in', 'out'] as const)" :key="port" :data-workflow-port="port" class="workflow-port-target" :class="{ active: connection?.id === step.id && connection.port === port, hovered: hoveredPort === step.id && connection?.port !== port }" tabindex="0" role="button" :aria-label="`${step.label}${port === 'in' ? '输入连接点' : '输出连接点'}`">
            <circle class="workflow-port-hit" cx="0" :cy="port === 'in' ? -height / 2 : height / 2" r="21" /><circle class="workflow-port" cx="0" :cy="port === 'in' ? -height / 2 : height / 2" r="6" />
          </g>
        </g>
      </g>
    </svg>
    <div v-if="connection" class="workflow-connection-hint" role="status">选择{{ connection.port === 'out' ? '输入' : '输出' }}连接点<button type="button" @click="cancelConnection">取消连线</button></div>
    <div class="workflow-canvas-tools" role="toolbar" aria-label="流程画布控制"><button type="button" aria-label="缩小流程画布" @click="zoom(1 / 1.2)">−</button><output>{{ Math.round(camera.scale * 100) }}%</output><button type="button" aria-label="放大流程画布" @click="zoom(1.2)">+</button><button type="button" @click="fit">适应画布</button><button type="button" :disabled="props.disabled" @click="emit('arrange')">自动整理</button></div>
    <p id="workflow-canvas-help" class="workflow-canvas-help">拖动节点自由布局 · 连接点拖线 / 点选连线 · 选中线可删除 · 双指缩放</p>
  </div>
</template>

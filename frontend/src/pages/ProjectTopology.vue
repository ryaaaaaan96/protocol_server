<script setup lang="ts">
import { computed } from "vue";
import type { Row } from "../api";
import { boardTypes, typeMounts } from "../domain/project";
import Loading from "../components/Loading.vue";
const props = defineProps<{ graph: Row | null }>();
const emit = defineEmits<{ board: [key: string] }>();
const types = computed(() => boardTypes(props.graph));
const links = computed(() => (props.graph ? typeMounts(props.graph) : []));
const nodeWidth = 230,
  nodeHeight = 120,
  columnStep = 420;
const layout = computed(() => {
  const positions = new Map<string, { x: number; y: number }>();
  const depths = new Map<string, number>();
  for (const type of types.value.filter(t => !t.parents.length)) depths.set(type.code, 0);
  // Longest-path layers place a shared child after all its parents, independent
  // of board/connection array order. Each board is drawn exactly once.
  for (let i = 0; i < types.value.length; i++) {
    let progressed = false;
    for (const type of types.value) {
      if (depths.has(type.code) || type.parents.some((link: Row) => !depths.has(link.parent))) continue;
      depths.set(type.code, 1 + Math.max(...type.parents.map((link: Row) => depths.get(link.parent)!)));
      progressed = true;
    }
    if (!progressed) break;
  }
  const layers = new Map<number, Row[]>();
  for (const type of types.value) {
    const depth = depths.get(type.code) || 0;
    if (!layers.has(depth)) layers.set(depth, []);
    layers.get(depth)!.push(type);
  }
  const maxRows = Math.max(1, ...[...layers.values()].map(layer => layer.length));
  const maxDepth = Math.max(0, ...layers.keys());
  for (const [depth, layer] of layers) {
    layer.forEach((type, index) => positions.set(type.code, {
      x: 30 + depth * columnStep,
      y: 30 + ((maxRows - layer.length) / 2 + index) * 160,
    }));
  }
  const labelAreas: { x: number; top: number; bottom: number }[] = [];
  const edges = links.value.map<Row & { path: string; labels: string[]; labelX: number; labelY: number }>((link: Row) => {
    const parent = positions.get(link.parent)!, child = positions.get(link.child)!;
    const startX = parent.x + nodeWidth, startY = parent.y + nodeHeight / 2;
    const endX = child.x, endY = child.y + nodeHeight / 2;
    const labels = link.connections.length
      ? link.connections.map((c: Row) => `${c.protocol} / ${c.transport === "CANFD" ? "CAN FD" : c.transport}`)
      : ["协议待配置"];
    const labelX = (startX + endX) / 2;
    let labelY = endY;
    const bottom = () => labelY + 28 + (labels.length - 1) * 18;
    // Shared children otherwise put incoming protocol labels at the same point.
    while (labelAreas.some(area => Math.abs(area.x - labelX) < 180 &&
      labelY - 40 < area.bottom && bottom() + 4 > area.top)) labelY += 90;
    labelAreas.push({ x: labelX, top: labelY - 36, bottom: bottom() });
    return {
      ...link, labels, labelX, labelY,
      path: `M ${startX} ${startY} C ${startX + 35} ${startY}, ${startX + 35} ${labelY}, ${startX + 60} ${labelY} L ${endX - 60} ${labelY} C ${endX - 35} ${labelY}, ${endX - 35} ${endY}, ${endX} ${endY}`,
    };
  });
  return {
    nodes: types.value.map<Row & { x: number; y: number }>((type) => ({
      ...type,
      ...positions.get(type.code)!,
    })),
    edges,
    width: Math.max(1130, 60 + maxDepth * columnStep + nodeWidth),
    height: Math.max(225, 60 + nodeHeight + (maxRows - 1) * 160,
      ...labelAreas.map(area => area.bottom + 30)),
  };
});
</script>
<template>
  <Loading v-if="!graph" />
  <template v-else>
    <section class="panel type-topology">
      <div class="directory-heading">
        <div>
          <h2>
            板卡通信拓扑 <span>{{ types.length }} 类板卡</span>
          </h2>
          <p>点击板卡查看点表，项目组成与连接通过服务器 JSON 定义。</p>
        </div>
      </div>
      <div v-if="!graph.project_config" class="notice config-reminder">
        尚未配置项目组成，可在项目设置中导入 JSON。
      </div>
      <div class="type-topology-canvas">
        <svg
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
          role="group"
          aria-label="项目板卡类型协议拓扑"
        >
          <defs>
            <marker
              id="type-arrow"
              markerUnits="userSpaceOnUse"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8" fill="#268f80" />
            </marker>
            <marker
              id="type-arrow-pending"
              markerUnits="userSpaceOnUse"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8" fill="#8196aa" />
            </marker>
          </defs>
          <g v-for="link in layout.edges" :key="link.id">
            <path
              class="type-connection-line"
              :data-parent="link.parent"
              :data-child="link.child"
              :d="link.path"
              fill="none"
              :stroke="!link.connections.length ? '#8196aa' : '#268f80'"
              :stroke-dasharray="!link.connections.length ? '7 5' : undefined"
              stroke-width="3"
              :marker-end="
                !link.connections.length
                  ? 'url(#type-arrow-pending)'
                  : 'url(#type-arrow)'
              "
            >
              <title>
                {{ link.name }} · {{ link.labels.join("、") }} · 每个上级挂载
                {{ link.quantity }} 个
              </title>
            </path>
            <text
              :x="link.labelX"
              :y="link.labelY - 24"
              text-anchor="middle"
              class="type-edge-count"
            >
              × {{ link.quantity }}
            </text>
            <text
              v-for="(label, i) in link.labels"
              :key="label"
              :x="link.labelX"
              :y="link.labelY + 25 + i * 18"
              text-anchor="middle"
              class="type-edge-protocol"
            >
              {{ label }}
            </text>
          </g>
          <g
            v-for="type in layout.nodes"
            :key="type.code"
            class="type-node"
            :data-code="type.code"
            role="button"
            tabindex="0"
            :aria-label="`查看 ${type.code} 板卡内部信息`"
            @click="emit('board', type.code)"
            @keydown.enter.prevent="emit('board', type.code)"
            @keydown.space.prevent="emit('board', type.code)"
          >
            <rect
              :x="type.x"
              :y="type.y"
              :width="nodeWidth"
              :height="nodeHeight"
              rx="9"
            />
            <text :x="type.x + 18" :y="type.y + 35" class="type-node-code">
              {{ type.code }}
            </text>
            <text :x="type.x + 18" :y="type.y + 60" class="type-node-name">
              {{ type.name }}
            </text>
            <text :x="type.x + 18" :y="type.y + 99" class="type-node-detail">
              {{
                type.parents.length > 1
                  ? `上级：${type.parents.map((link: Row) => link.parent).join("、")}`
                  : type.parents.length
                    ? `每个 ${type.parent} 挂载 ${type.per_parent} 个`
                    : `根板卡 × ${type.quantity}`
              }}
            </text>
          </g>
        </svg>
      </div>
      <div class="type-topology-legend">
        <span><i class="status-dot" />已配置协议</span
        ><span><i class="pending-dot" />协议待配置</span
        ><span>{{
          types.map((t) => `${t.code} × ${t.quantity}`).join(" · ")
        }}</span>
      </div>
    </section>
  </template>
</template>

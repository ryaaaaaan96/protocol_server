<script setup lang="ts">
import { computed } from "vue";
import type { Row } from "../api";
import { boardTypes, typeMounts } from "../domain/project";
import Loading from "../components/Loading.vue";
const props = defineProps<{ graph: Row | null }>();
const emit = defineEmits<{ board: [id: number] }>();
const types = computed(() => boardTypes(props.graph));
const links = computed(() => (props.graph ? typeMounts(props.graph) : []));
const nodeWidth = 230,
  nodeHeight = 120,
  columnStep = 420;
const layout = computed(() => {
  const positions = new Map<string, { x: number; y: number }>();
  const visited = new Set<string>();
  let leaf = 0,
    maxDepth = 0;
  function place(code: string, depth: number): number {
    visited.add(code);
    maxDepth = Math.max(maxDepth, depth);
    const childCenters = links.value
      .filter((link) => link.parent === code && !visited.has(link.child))
      .map((link) => place(link.child, depth + 1));
    const center = childCenters.length
      ? (childCenters[0] + childCenters[childCenters.length - 1]) / 2
      : 90 + leaf++ * 160;
    positions.set(code, {
      x: 30 + depth * columnStep,
      y: center - nodeHeight / 2,
    });
    return center;
  }
  // Derive branches from the project relationships, independently of JSON array order.
  for (const type of types.value.filter((t) => !t.parent)) place(type.code, 0);
  for (const type of types.value)
    if (!visited.has(type.code)) place(type.code, 0);
  return {
    nodes: types.value.map<Row & { x: number; y: number }>((type) => ({
      ...type,
      ...positions.get(type.code)!,
    })),
    edges: links.value.map<
      Row & { path: string; labelX: number; labelY: number }
    >((link) => {
      const parent = positions.get(link.parent)!,
        child = positions.get(link.child)!;
      const startX = parent.x + nodeWidth,
        startY = parent.y + nodeHeight / 2;
      const endX = child.x,
        endY = child.y + nodeHeight / 2;
      return {
        ...link,
        labels: link.connections.length
          ? link.connections.map(
              (c: Row) =>
                `${c.protocol} / ${c.transport === "CANFD" ? "CAN FD" : c.transport}`,
            )
          : ["协议待配置"],
        path: `M ${startX} ${startY} C ${startX + 35} ${startY}, ${startX + 35} ${endY}, ${startX + 60} ${endY} L ${endX} ${endY}`,
        labelX: (startX + 60 + endX) / 2,
        labelY: endY,
      };
    }),
    width: Math.max(1130, 60 + maxDepth * columnStep + nodeWidth),
    height: Math.max(225, 60 + nodeHeight + (leaf - 1) * 160),
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
          <p>点击板卡，查看对应的内部点表与协议配置。</p>
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
            @click="emit('board', type.id)"
            @keydown.enter.prevent="emit('board', type.id)"
            @keydown.space.prevent="emit('board', type.id)"
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
                type.parent
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

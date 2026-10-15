<script setup lang="ts">
import { computed } from "vue";
import type { Row } from "../api";
import { boardTypes, typeConnections } from "../domain/project";
import Loading from "../components/Loading.vue";
const props = defineProps<{ graph: Row | null }>();
const emit = defineEmits<{ board: [id: number] }>();
const types = computed(() => boardTypes(props.graph));
const links = computed(() => (props.graph ? typeConnections(props.graph) : []));
function nodeX(code: string) {
  return 30 + types.value.findIndex((t) => t.code === code) * 340;
}
function typeEdge(link: Row) {
  return `M ${nodeX(link.parent) + 230} 112 L ${nodeX(link.child)} 112`;
}
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
          :viewBox="`0 0 ${Math.max(1020, types.length * 340)} 225`"
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
          <g v-for="link in links" :key="link.id">
            <path
              class="type-connection-line"
              :data-parent="link.parent"
              :data-child="link.child"
              :d="typeEdge(link)"
              fill="none"
              :stroke="link.protocol === '待配置' ? '#8196aa' : '#268f80'"
              :stroke-dasharray="link.protocol === '待配置' ? '7 5' : undefined"
              stroke-width="3"
              :marker-end="
                link.protocol === '待配置'
                  ? 'url(#type-arrow-pending)'
                  : 'url(#type-arrow)'
              "
            >
              <title>
                {{ link.name }} · {{ link.protocol }} · 每个上级挂载
                {{ link.quantity }} 个
              </title>
            </path>
            <text
              :x="(nodeX(link.parent) + 230 + nodeX(link.child)) / 2"
              y="88"
              text-anchor="middle"
              class="type-edge-count"
            >
              × {{ link.quantity }}
            </text>
            <text
              :x="(nodeX(link.parent) + 230 + nodeX(link.child)) / 2"
              y="143"
              text-anchor="middle"
              class="type-edge-protocol"
            >
              {{
                link.protocol === "待配置"
                  ? "协议待配置"
                  : `${link.protocol} / ${link.transport}`
              }}
            </text>
          </g>
          <g
            v-for="type in types"
            :key="type.code"
            class="type-node"
            role="button"
            tabindex="0"
            :aria-label="`查看 ${type.code} 板卡内部信息`"
            @click="emit('board', type.id)"
            @keydown.enter.prevent="emit('board', type.id)"
            @keydown.space.prevent="emit('board', type.id)"
          >
            <rect
              :x="nodeX(type.code)"
              y="52"
              width="230"
              height="120"
              rx="9"
            />
            <text :x="nodeX(type.code) + 18" y="87" class="type-node-code">
              {{ type.code }}
            </text>
            <text :x="nodeX(type.code) + 18" y="112" class="type-node-name">
              {{ type.name }}
            </text>
            <text :x="nodeX(type.code) + 18" y="151" class="type-node-detail">
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

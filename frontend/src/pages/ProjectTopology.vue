<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import type { ELK } from "elkjs/lib/elk-api";
import { RefreshCw } from "@lucide/vue";
import type { Row } from "../api";
import { boardTypes, typeMounts } from "../domain/project";
import { layoutTopology, nodeWidth, nodeHeight, type TopologyDirection, type TopologyRouting, type TopologyLayout } from "../domain/topologyLayout";
import Loading from "../components/Loading.vue";
const props = defineProps<{ graph: Row | null }>();
const emit = defineEmits<{ board: [key: string] }>();
const types = computed(() => boardTypes(props.graph));
const links = computed(() => (props.graph ? typeMounts(props.graph) : []));
const direction = ref<TopologyDirection>("RIGHT"), rearrange = ref(0), busy = ref(false), error = ref("");
const routing = ref<TopologyRouting>("SPLINES");
const layout = shallowRef<TopologyLayout | null>(null);
// Row edits refresh the project graph too; only topology changes need layout.
const signature = computed(() => JSON.stringify({
  boards: types.value.map(board => [board.code, board.name, board.quantity]).sort(),
  links: links.value.map(link => [link.parent, link.child, link.quantity, link.connections]).sort(),
}));
watch([signature, direction, routing, rearrange], async (_, __, cleanup) => {
  let cancelled = false, engine: ELK | undefined;
  cleanup(() => { cancelled = true; engine?.terminateWorker(); });
  busy.value = true;
  error.value = "";
  layout.value = null;
  try {
    if (!types.value.length) return;
    const { createLayoutEngine } = await import("../domain/topologyWorker");
    if (cancelled) return;
    engine = createLayoutEngine();
    const result = await layoutTopology(engine, types.value, links.value, direction.value, routing.value);
    if (!cancelled) layout.value = result;
  } catch (cause) {
    if (!cancelled) error.value = `拓扑布局失败：${(cause as Error).message}`;
  } finally {
    engine?.terminateWorker();
    if (!cancelled) busy.value = false;
  }
}, { immediate: true });
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
        <div class="topology-layout-actions" role="group" aria-label="拓扑布局">
          <select v-model="direction" class="button small" aria-label="布局方向">
            <option value="RIGHT">横向布局</option>
            <option value="DOWN">纵向布局</option>
          </select>
          <select v-model="routing" class="button small" aria-label="连线样式">
            <option value="SPLINES">平滑曲线</option>
            <option value="ORTHOGONAL">直角折线</option>
          </select>
          <button class="button small" :disabled="busy" @click="rearrange++">
            <RefreshCw :size="15" />{{ busy ? "整理中…" : "自动整理" }}
          </button>
        </div>
      </div>
      <div v-if="!graph.project_config" class="notice config-reminder">
        尚未配置项目组成，可在项目设置中导入 JSON。
      </div>
      <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
      <Loading v-if="busy" />
      <div v-if="layout" class="type-topology-canvas">
        <svg
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
          role="group"
          aria-label="项目板卡类型协议拓扑"
          :data-routing="layout.routing"
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
              stroke-linejoin="round"
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
              :x="link.label.x + link.label.width / 2"
              :y="link.label.y + 21"
              text-anchor="middle"
              class="type-edge-count"
            >
              × {{ link.quantity }}
            </text>
            <text
              v-for="(label, i) in link.labels"
              :key="label"
              :x="link.label.x + link.label.width / 2"
              :y="link.label.y + 42 + i * 18"
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

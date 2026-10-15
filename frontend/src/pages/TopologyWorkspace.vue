<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { api, type Row } from "../api";
import { specs, labels, labelFor } from "../domain/schema";
import {
  Plus,
  Search,
  ArrowRight,
  Network,
  Layers3,
  Box,
  Database,
  FileSpreadsheet,
  ChevronLeft,
  ChevronRight,
} from "@lucide/vue";
import ChangeEditor from "../components/ChangeEditor.vue";
import Modal from "../components/Modal.vue";
import Loading from "../components/Loading.vue";
import Empty from "../components/Empty.vue";
import Badge from "../components/Badge.vue";
const props = defineProps<{
  pid: number;
  tick: number;
  canWrite: boolean;
  mode: "topology" | "data" | "config";
  focus?: Row | null;
}>();
const emit = defineEmits<{ done: []; error: [message: string] }>();
const graph = ref<Row | null>(null),
  error = ref(""),
  entity = ref(
    props.mode === "topology"
      ? "board_links"
      : props.mode === "data"
        ? "data_items"
        : "board_models",
  ),
  query = ref(""),
  modelFilter = ref(0),
  page = ref(1),
  selectedBoard = ref(0),
  edit = ref<{ entity: string; row: Row | null } | null>(null),
  source = ref<Row | null>(null);
const dataTabs = [
  "data_items",
  "signals",
  "signal_ranges",
  "protocol_fields",
  "signal_bindings",
  "passthrough_routes",
];
const configTabs = [
  "board_models",
  "boards",
  "signal_groups",
  "device_contexts",
  "protocol_contracts",
  "endpoints",
  "platform_signals",
];
const tabs = computed(() =>
  props.mode === "topology"
    ? ["board_links", "boards", "endpoints", "passthrough_routes"]
    : props.mode === "data"
      ? dataTabs
      : configTabs,
);
watch(
  () => [props.pid, props.tick],
  async (_, __, cleanup) => {
    let cancelled = false;
    cleanup(() => {
      cancelled = true;
    });
    try {
      const g = await api(`/projects/${props.pid}/topology`);
      if (cancelled) return;
      graph.value = g;
      error.value = "";
      if (props.focus && specs[props.focus.entity]) {
        entity.value = props.focus.entity;
        const r = g[props.focus.entity]?.find(
          (r: Row) => r.id === props.focus!.id,
        );
        if (r) edit.value = { entity: props.focus.entity, row: r };
      }
    } catch (e) {
      if (!cancelled) error.value = (e as Error).message;
    }
  },
  { immediate: true },
);
watch([entity, query, modelFilter], () => (page.value = 1));
const spec = computed(() => specs[entity.value]);
const displayRows = computed(() => {
  if (!graph.value) return [];
  return (graph.value[spec.value.view || entity.value] || []).filter(
    (r: Row) => {
      if (modelFilter.value) {
        let matches = r.model_id === modelFilter.value;
        if (entity.value === "data_items")
          matches =
            graph.value!.v_signals.some(
              (s: Row) =>
                s.model_id === modelFilter.value && s.data_item_id === r.id,
            ) ||
            graph.value!.protocol_fields.some(
              (f: Row) =>
                f.data_item_id === r.id &&
                graph.value!.endpoints.some(
                  (e: Row) =>
                    e.model_id === modelFilter.value &&
                    e.contract_id === f.contract_id,
                ),
            );
        if (entity.value === "protocol_fields")
          matches = graph.value!.endpoints.some(
            (e: Row) =>
              e.model_id === modelFilter.value &&
              e.contract_id === r.contract_id,
          );
        if (entity.value === "signal_ranges")
          matches = graph.value!.v_signals.some(
            (s: Row) =>
              s.model_id === modelFilter.value && s.id === r.signal_id,
          );
        if (entity.value === "passthrough_routes")
          matches = graph.value!.endpoints.some(
            (e: Row) =>
              e.model_id === modelFilter.value && e.id === r.server_endpoint_id,
          );
        if (entity.value === "board_links")
          matches = graph.value!.boards.some(
            (b: Row) =>
              b.model_id === modelFilter.value &&
              (b.id === r.client_board_id || b.id === r.server_board_id),
          );
        if (
          !matches &&
          !["protocol_contracts", "platform_signals", "board_models"].includes(
            entity.value,
          )
        )
          return false;
      }
      return (
        !query.value ||
        spec.value.columns
          .map((k) => cell(r, k))
          .join(" ")
          .toLowerCase()
          .includes(query.value.toLowerCase())
      );
    },
  );
});
const pages = computed(() =>
  Math.max(1, Math.ceil(displayRows.value.length / 40)),
);
const visible = computed(() =>
  displayRows.value.slice((page.value - 1) * 40, page.value * 40),
);
function cell(r: Row, k: string) {
  const f = spec.value.fields.find((f) => f.key === k);
  if (f?.ref) return labelFor(graph.value!, f.ref, r[k]);
  return r[k] == null
    ? "—"
    : typeof r[k] === "boolean"
      ? r[k]
        ? "是"
        : "否"
      : String(r[k]);
}
function open(row: Row) {
  edit.value = {
    entity: entity.value,
    row: graph.value![entity.value].find((r: Row) => r.id === row.id),
  };
}
function done() {
  edit.value = null;
  emit("done");
}
const model = (id: number) =>
  graph.value?.board_models.find((m: Row) => m.id === id);
const boardInfo = computed(() =>
  graph.value?.boards.find((b: Row) => b.id === selectedBoard.value),
);
const boardEndpoints = computed(
  () =>
    graph.value?.endpoints.filter(
      (e: Row) => e.model_id === boardInfo.value?.model_id,
    ) || [],
);
const nodes = computed<{ height: number; items: Row[] }>(() => {
  const boards: Row[] = graph.value?.boards || [];
  const clients = new Set(
    (graph.value?.board_links || []).map((l: Row) => l.client_board_id),
  );
  const left = boards.filter((b) => clients.has(b.id)),
    right = boards.filter((b) => !clients.has(b.id));
  const h = Math.max(380, Math.max(left.length, right.length) * 96 + 40);
  return {
    height: h,
    items: [
      ...left.map((b, i) => ({
        ...b,
        x: 30,
        y: ((i + 0.5) * h) / Math.max(1, left.length) - 34,
      })),
      ...right.map((b, i) => ({
        ...b,
        x: 510,
        y: ((i + 0.5) * h) / Math.max(1, right.length) - 34,
      })),
    ],
  };
});
function path(l: Row) {
  const a = nodes.value.items.find((b) => b.id === l.client_board_id),
    b = nodes.value.items.find((b) => b.id === l.server_board_id);
  return a && b
    ? `M ${a.x + 260} ${a.y + 34} C ${a.x + 355} ${a.y + 34}, ${b.x - 105} ${b.y + 34}, ${b.x} ${b.y + 34}`
    : "";
}
const expansion = ref(false),
  sources = ref(false);
const sourceRows = computed(
  () =>
    graph.value?.source_records
      .filter((r: Row) => !query.value || r.sheet.includes(query.value))
      .slice(0, 100) || [],
);
async function showSource(r: Row) {
  try {
    source.value = await api(`/projects/${props.pid}/sources/${r.id}`);
  } catch (e) {
    emit("error", (e as Error).message);
  }
}
</script>
<template>
  <div v-if="error" class="notice danger">{{ error }}</div>
  <Loading v-else-if="!graph" /><template v-else>
    <div class="topology-stats">
      <div>
        <Box :size="18" /><strong>{{ graph.boards.length }}</strong
        ><span>板卡实例</span>
      </div>
      <div>
        <Layers3 :size="18" /><strong>{{ graph.board_models.length }}</strong
        ><span>共享模板</span>
      </div>
      <div>
        <Network :size="18" /><strong>{{ graph.board_links.length }}</strong
        ><span>协议连接</span>
      </div>
      <div>
        <Database :size="18" /><strong>{{ graph.signals.length }}</strong
        ><span>内部信号定义</span>
      </div>
    </div>
    <section v-if="mode === 'topology'" class="panel topology-panel">
      <div class="panel-heading">
        <div>
          <h3>板卡与协议连接</h3>
          <p>
            选择板卡查看端点。同一模板的多个实例共享配置，通信地址分别设置。
          </p>
        </div>
        <button
          v-if="canWrite"
          class="button primary small"
          @click="edit = { entity: 'board_links', row: null }"
        >
          <Plus :size="15" />添加连接
        </button>
      </div>
      <div v-if="graph.boards.length" class="topology-layout">
        <div class="topology-canvas">
          <svg
            :viewBox="`0 0 800 ${nodes.height}`"
            role="img"
            aria-label="项目板卡协议拓扑"
          >
            <defs>
              <marker
                id="topology-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M 0 0 L 8 4 L 0 8" fill="#49a89b" />
              </marker>
            </defs>
            <g v-for="l in graph.v_topology_links" :key="l.id">
              <path
                :d="path(l)"
                fill="none"
                stroke="#82bdb3"
                stroke-width="2"
                marker-end="url(#topology-arrow)"
              />
              <title>
                {{ l.client_board }} → {{ l.server_board }} · {{ l.protocol }} /
                {{ l.transport }} · 地址 {{ l.remote_address }}
              </title>
            </g>
            <g
              v-for="b in nodes.items"
              :key="b.id"
              role="button"
              tabindex="0"
              :aria-label="`查看板卡 ${b.name}`"
              @click="selectedBoard = b.id"
              @keydown.enter="selectedBoard = b.id"
              class="board-node"
            >
              <rect
                :x="b.x"
                :y="b.y"
                width="260"
                height="68"
                rx="12"
                :fill="selectedBoard === b.id ? '#e2f6f1' : '#fff'"
                :stroke="selectedBoard === b.id ? '#168b79' : '#d5e1ec'"
              />
              <text :x="b.x + 18" :y="b.y + 28" class="board-node-title">
                {{ b.name }}
              </text>
              <text :x="b.x + 18" :y="b.y + 49" class="board-node-caption">
                {{ b.code }} · {{ model(b.model_id)?.name }}
              </text>
            </g>
          </svg>
        </div>
        <aside class="board-inspector">
          <template v-if="boardInfo"
            ><Badge tone="teal">板卡实例</Badge>
            <h3>{{ boardInfo.name }}</h3>
            <p>{{ model(boardInfo.model_id)?.name }}</p>
            <code>{{ boardInfo.code }}</code>
            <h4>协议端点</h4>
            <article v-for="e in boardEndpoints" :key="e.id">
              <strong>{{ e.name }}</strong>
              <p>
                {{ e.role === "client" ? "采集端" : "服务端" }} ·
                {{ e.transport }} · {{ e.port || "端口待配置" }}
              </p>
              <small>{{
                labelFor(graph, "protocol_contracts", e.contract_id)
              }}</small>
            </article>
            <button
              class="button small"
              @click="
                modelFilter = boardInfo.model_id;
                entity = 'endpoints';
              "
            >
              筛选此板卡的端点</button
            ><button
              v-if="canWrite"
              class="text-button"
              @click="edit = { entity: 'boards', row: boardInfo }"
            >
              编辑板卡实例
            </button></template
          ><template v-else
            ><Network :size="30" />
            <h3>查看板卡关系</h3>
            <p>点击图中的板卡，查看它所用的模板、通信协议和端口。</p>
            <div class="notice">
              箭头从协议采集方指向服务方。读写数据可沿同一连接双向传输。
            </div></template
          >
        </aside>
      </div>
      <Empty
        v-else
        title="项目还没有板卡"
        detail="先建立板卡模板和实例，再添加协议端点与连接。"
        ><button
          v-if="canWrite"
          class="button"
          @click="edit = { entity: 'board_models', row: null }"
        >
          创建板卡模板
        </button></Empty
      >
    </section>
    <section class="panel table-panel section-gap">
      <div class="entity-tabs">
        <button
          v-for="t in tabs"
          :key="t"
          :class="{ selected: entity === t && !expansion && !sources }"
          @click="
            entity = t;
            expansion = false;
            sources = false;
          "
        >
          {{ specs[t].label }}<small>{{ graph[t].length }}</small></button
        ><button
          v-if="mode === 'data'"
          :class="{ selected: expansion }"
          @click="
            expansion = true;
            sources = false;
          "
        >
          透传地址展开</button
        ><button
          v-if="mode === 'data'"
          :class="{ selected: sources }"
          @click="
            sources = true;
            expansion = false;
          "
        >
          工作簿来源
        </button>
      </div>
      <div class="table-toolbar">
        <div class="search">
          <Search :size="16" /><input
            aria-label="搜索配置"
            placeholder="搜索名称、sigID、协议地址…"
            v-model="query"
          />
        </div>
        <div class="inline">
          <select
            v-if="!sources && !expansion"
            aria-label="筛选板卡模板"
            v-model.number="modelFilter"
          >
            <option :value="0">全部板卡模板</option>
            <option v-for="m in graph.board_models" :value="m.id" :key="m.id">
              {{ m.name }}
            </option></select
          ><Badge v-if="sources">原始值与公式</Badge
          ><button
            v-if="canWrite && !expansion && !sources"
            class="button primary small"
            @click="edit = { entity, row: null }"
          >
            <Plus :size="15" />新建{{ spec.label }}
          </button>
        </div>
      </div>
      <template v-if="sources"
        ><div class="notice">
          已映射的源行与待接入工作表分别保留。CSU、BMS、侦测板的物理连接需要明确后再建立；未按名称自动猜测。
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>工作表</th>
                <th>行号</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in sourceRows" :key="r.id">
                <td>{{ r.sheet }}</td>
                <td>{{ r.row_number }}</td>
                <td>
                  {{
                    r.classification === "linked" ? "已用于建模" : "待映射来源"
                  }}
                </td>
                <td>
                  <button class="text-button" @click="showSource(r)">
                    查看单元格与公式
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="padded muted">展示前 100 条匹配来源。</p></template
      >
      <template v-else-if="expansion"
        ><div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>透传窗口</th>
                <th>字段</th>
                <th>北向地址</th>
                <th>寄存器数</th>
                <th>UPP 模型</th>
                <th>UPP 偏移</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(r, i) in graph.v_passthrough_fields
                  .filter(
                    (r: Row) =>
                      !query ||
                      `${r.name} ${r.route_name} ${r.register_address}`.includes(
                        query,
                      ),
                  )
                  .slice(0, 150)"
                :key="i"
              >
                <td>{{ r.route_name }}</td>
                <td>{{ r.name }}</td>
                <td class="mono">{{ r.register_address }}</td>
                <td>{{ r.register_length }}</td>
                <td>{{ r.upp_model }}</td>
                <td>{{ r.upp_offset }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="padded muted">
          展示前 150 条；SQL 工作台可查询全部展开结果。
        </p></template
      >
      <template v-else
        ><div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th v-for="k in spec.columns" :key="k">
                  {{
                    spec.fields.find((f) => f.key === k)?.label ||
                    labels[k] ||
                    k
                  }}
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in visible" :key="r.id">
                <td v-for="(k, i) in spec.columns" :key="k">
                  <button
                    v-if="i === 0"
                    class="text-button record-name"
                    @click="open(r)"
                  >
                    {{ cell(r, k) }}</button
                  ><span v-else>{{ cell(r, k) }}</span>
                </td>
                <td>
                  <button
                    class="icon-btn"
                    aria-label="查看配置关系"
                    @click="open(r)"
                  >
                    <ChevronRight :size="16" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Empty
          v-if="!visible.length"
          title="暂无匹配配置"
          detail="调整筛选，或创建一条新配置。" />
        <div class="pagination">
          <span
            >{{ displayRows.length }} 条 · 第 {{ page }} / {{ pages }} 页</span
          >
          <div class="inline">
            <button
              class="icon-btn"
              :disabled="page <= 1"
              aria-label="上一页"
              @click="page--"
            >
              <ChevronLeft :size="16" /></button
            ><button
              class="icon-btn"
              :disabled="page >= pages"
              aria-label="下一页"
              @click="page++"
            >
              <ChevronRight :size="16" />
            </button>
          </div></div
      ></template>
    </section>
    <ChangeEditor
      v-if="edit"
      :key="`${edit.entity}:${edit.row?.id || 'new'}`"
      :pid="pid"
      :graph="graph"
      :entity="edit.entity"
      :row="edit.row"
      :can-write="canWrite"
      @close="edit = null"
      @done="done"
    />
    <Modal
      v-if="source"
      :title="`${source.sheet} · 第 ${source.row_number} 行`"
      wide
      @close="source = null"
      ><div class="modal-body">
        <pre class="source-json">{{
          JSON.stringify(source.cells, null, 2)
        }}</pre>
      </div></Modal
    >
  </template>
</template>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { api, type Row } from "../api";
import { specs, labels, labelFor } from "../domain/schema";
import {
  boardSheets,
  projectSheets,
  scopedRows,
  rows,
  type Sheet,
} from "../domain/board";
import {
  Plus,
  Search,
  ArrowRight,
  Box,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
} from "@lucide/vue";
import ChangeEditor from "../components/ChangeEditor.vue";
import { boardTypes, typeConnections } from "../domain/project";
import Modal from "../components/Modal.vue";
import Loading from "../components/Loading.vue";
import Empty from "../components/Empty.vue";
import PointTable from "../components/PointTable.vue";
const props = defineProps<{
  pid: number;
  graph: Row | null;
  canWrite: boolean;
  mode: "board" | "settings";
  boardId: number;
  focus?: Row | null;
}>();
const emit = defineEmits<{
  done: [];
  error: [message: string];
  board: [id: number];
  settings: [];
  configuration: [];
  sheet: [label: string];
}>();
const types = computed(() => boardTypes(props.graph));
const board = computed(() =>
  props.mode === "board"
    ? types.value.find((t) => t.id === props.boardId)
    : undefined,
);
const boardModel = computed(() =>
  props.graph?.board_models.find((m: Row) => m.id === board.value?.model_id),
);
function typeSignals(type: Row) {
  return (
    props.graph?.v_signals.filter((s: Row) => s.model_id === type.model_id)
      .length || 0
  );
}
const sheetKey = ref(props.mode === "settings" ? "models" : "signals"),
  query = ref(""),
  page = ref(1);
const advanced = ref(false),
  pointFocus = ref<number>();
const edit = ref<{
    entity: string;
    row: Row | null;
    defaults?: Row;
    role?: string;
  } | null>(null),
  source = ref<Row | null>(null);
const sheets = computed(() =>
  props.mode === "settings" ? projectSheets : boardSheets,
);
const sheet = computed<Sheet>(
  () => sheets.value.find((s) => s.key === sheetKey.value) || sheets.value[0],
);
const visibleSheets = computed(() =>
  sheets.value.filter(
    (s) => props.mode === "settings" || advanced.value || s.pointKind,
  ),
);
const spec = computed(() => specs[sheet.value.entity]);
const columns = computed(
  () => sheet.value.columns || spec.value?.columns || [],
);
const captions: Record<string, string> = {
  ...labels,
  signal_name: "内部信号",
  resolved_sig_id: "sigID",
  default_value: "默认值",
  min_value: "下限",
  max_value: "上限",
  route_name: "透传窗口",
  register_address: "北向地址",
  register_length: "寄存器数",
  upp_model: "UPP 模型",
  upp_offset: "UPP 偏移",
  sheet: "工作表",
  row_number: "行号",
  classification: "映射状态",
  quantity: "每个上级挂载数",
};
watch(
  () => [props.boardId, props.mode],
  () => {
    query.value = "";
    page.value = 1;
    edit.value = null;
    source.value = null;
    pointFocus.value = undefined;
  },
);
watch(
  () => [props.graph, props.focus],
  () => {
    if (!props.graph || !props.focus) return;
    const target = sheets.value.find(
      (s) =>
        s.entity === props.focus!.entity &&
        (!s.role ||
          props.graph!.v_bindings.find((b: Row) => b.id === props.focus!.id)
            ?.role === s.role),
    );
    if (target) {
      sheetKey.value = target.key;
      if (target.pointKind) {
        pointFocus.value = props.focus.id;
        return;
      }
      advanced.value = true;
    }
    const row = props.graph[props.focus.entity]?.find(
      (r: Row) => r.id === props.focus!.id,
    );
    if (row && specs[props.focus.entity])
      edit.value = { entity: props.focus.entity, row, role: target?.role };
  },
  { immediate: true },
);
watch(
  () => sheet.value.label,
  (label) => emit("sheet", label),
  { immediate: true },
);
watch([sheetKey, query], () => (page.value = 1));
function entries(s: Sheet): Row[] {
  if (!props.graph) return [];
  if (s.entity === "type_connections")
    return typeConnections(props.graph).filter(
      (r) => r.parent === board.value?.code || r.child === board.value?.code,
    );
  let records = rows(props.graph, s.view || specs[s.entity]?.view || s.entity);
  records = scopedRows(props.graph, board.value, s.entity, records);
  if (s.role) records = records.filter((r) => r.role === s.role);
  if (s.entity === "signal_ranges")
    records = records.map((r) => {
      const signal = props.graph!.v_signals.find(
        (v: Row) => v.id === r.signal_id,
      );
      return {
        ...r,
        signal_name: signal?.name,
        resolved_sig_id: signal?.resolved_sig_id,
        default_value: signal?.default_value,
        min_value: signal?.min_value,
        max_value: signal?.max_value,
      };
    });
  return records;
}
const sheetRecords = computed(() => entries(sheet.value));
function cell(r: Row, key: string): string {
  if (key === "classification")
    return r[key] === "linked" ? "已用于建模" : "待映射";
  const f = spec.value?.fields.find((f) => f.key === key);
  if (f?.ref) return labelFor(props.graph!, f.ref, r[key]);
  return r[key] == null
    ? "—"
    : typeof r[key] === "boolean"
      ? r[key]
        ? "是"
        : "否"
      : String(r[key]);
}
const filtered = computed(() =>
  sheetRecords.value.filter(
    (r) =>
      !query.value ||
      columns.value
        .map((k) => cell(r, k))
        .join(" ")
        .toLowerCase()
        .includes(query.value.trim().toLowerCase()),
  ),
);
const pages = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / 50)),
);
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * 50, page.value * 50),
);
watch(pages, (n) => (page.value = Math.min(page.value, n)));
const canCreate = computed(
  () =>
    props.canWrite &&
    !!spec.value &&
    !(props.mode === "board" && sheet.value.entity === "data_items"),
);
function open(row: Row) {
  if (!spec.value) return;
  edit.value = {
    entity: sheet.value.entity,
    row: props.graph![sheet.value.entity].find((r: Row) => r.id === row.id),
    role: sheet.value.role,
  };
}
function create(entity = sheet.value.entity) {
  const defaults: Row = {};
  const g = props.graph!,
    b = board.value;
  if (b) {
    if (specs[entity].fields.some((f) => f.key === "model_id"))
      defaults.model_id = b.model_id;
    if (entity === "signals") {
      defaults.group_id = g.signal_groups.find(
        (r: Row) => r.model_id === b.model_id,
      )?.id;
      defaults.process_enabled = boardModel.value?.firmware_profile === "aidc";
    }
    if (entity === "signal_bindings")
      defaults.endpoint_id = g.endpoints.find(
        (e: Row) => e.model_id === b.model_id && e.role === sheet.value.role,
      )?.id;
    if (entity === "protocol_fields")
      defaults.contract_id = g.endpoints.find(
        (e: Row) => e.model_id === b.model_id,
      )?.contract_id;
    if (entity === "board_links") {
      const ep = g.endpoints.find(
        (e: Row) => e.model_id === b.model_id && e.role === "client",
      );
      if (ep) {
        defaults.client_board_id = b.id;
        defaults.client_endpoint_id = ep.id;
      } else {
        defaults.server_board_id = b.id;
        defaults.server_endpoint_id = g.endpoints.find(
          (e: Row) => e.model_id === b.model_id && e.role === "server",
        )?.id;
      }
    }
  }
  edit.value = { entity, row: null, defaults, role: sheet.value.role };
}
function done(record: Row) {
  const entering = edit.value?.entity === "boards" && !edit.value.row;
  edit.value = null;
  emit("done");
  if (entering) emit("board", record.id);
}
function pointDone() {
  pointFocus.value = undefined;
  emit("done");
}
function openProcess(id: number) {
  sheetKey.value = "signals";
  pointFocus.value = id;
}
function toggleAdvanced() {
  advanced.value = !advanced.value;
  if (!advanced.value && !sheet.value.pointKind) sheetKey.value = "signals";
}
async function showSource(row: Row) {
  try {
    source.value = await api(`/projects/${props.pid}/sources/${row.id}`);
  } catch (e) {
    emit("error", (e as Error).message);
  }
}
function sourceOf(row: Row) {
  return props.graph?.source_records.find(
    (r: Row) => r.sheet === row.source_sheet && r.row_number === row.source_row,
  );
}
</script>
<template>
  <Loading v-if="!graph" />
  <Empty
    v-else-if="mode === 'board' && !board"
    title="先配置板卡类型"
    detail="通过项目 JSON 定义板卡类型后，即可维护各自的点表和协议。"
    ><button class="button" @click="emit('configuration')">
      项目 JSON 配置
    </button></Empty
  >
  <template v-else>
    <div
      v-if="board"
      class="board-type-selector"
      role="group"
      aria-label="选择板卡类型"
    >
      <button
        v-for="type in types"
        :key="type.code"
        :class="['board-type-choice', { selected: type.id === boardId }]"
        :aria-label="`选择 ${type.code} 板卡`"
        :aria-pressed="type.id === boardId"
        @click="emit('board', type.id)"
      >
        <Box :size="21" />
        <div>
          <strong>{{ type.code }}</strong
          ><span>{{ type.name }}</span>
        </div>
        <small>{{ typeSignals(type) }} 个信号</small>
      </button>
    </div>
    <section class="panel table-panel board-tables">
      <div
        class="entity-tabs"
        role="tablist"
        :aria-label="board ? '板卡内表格' : '项目共享配置'"
      >
        <button
          v-for="s in visibleSheets"
          :key="s.key"
          role="tab"
          :aria-selected="sheetKey === s.key"
          :class="{ selected: sheetKey === s.key }"
          @click="
            sheetKey = s.key;
            query = '';
            pointFocus = undefined;
          "
        >
          {{ s.label }}<small>{{ entries(s).length }}</small>
        </button>
      </div>
      <div v-if="mode === 'board'" class="point-settings-toggle">
        <span>处理点定义内部数据，采集和转发维护协议映射。</span>
        <button
          class="text-button"
          :aria-expanded="advanced"
          @click="toggleAdvanced"
        >
          {{ advanced ? "收起辅助配置" : "展开辅助配置" }}
        </button>
      </div>
      <PointTable
        v-if="sheet.pointKind && board && graph"
        :key="`${board.model_id}:${sheet.pointKind}`"
        :pid="pid"
        :model-id="board.model_id"
        :kind="sheet.pointKind"
        :revision="graph.revision"
        :can-write="canWrite"
        :process-enabled="boardModel?.firmware_profile === 'aidc'"
        :focus-id="pointFocus"
        @done="pointDone"
        @process="openProcess"
        @error="emit('error', $event)"
      />
      <template v-else>
        <div class="sheet-heading">
          <h2>{{ sheet.label }}</h2>
          <span v-if="sheet.role">{{
            sheet.role === "client"
              ? "从协议端点采集到本板内部信号"
              : "将本板内部信号映射到对外协议字段"
          }}</span
          ><span v-else-if="sheet.entity === 'signal_ranges'"
            >显示当前生效的范围值，支持单独覆盖与恢复策略。</span
          ><span v-else-if="board && sheet.entity === 'data_items'"
            >显示本板引用的数据定义；新定义在项目共享目录中维护。</span
          ><span v-else-if="sheet.entity === 'source_records'"
            >原始单元格和公式 · 尚未明确的板卡来源保留为待映射</span
          >
        </div>
        <div
          v-if="sheet.entity === 'type_connections'"
          class="notice type-link-notice"
        >
          <span
            >挂载关系及协议在项目 JSON
            中维护；同一关系可有多种协议，挂载数量不叠加。</span
          ><button class="text-button" @click="emit('configuration')">
            项目 JSON 配置 <ArrowRight :size="15" />
          </button>
        </div>
        <div class="table-toolbar">
          <div class="search">
            <Search :size="17" /><input
              v-model="query"
              aria-label="搜索当前表格"
              placeholder="搜索名称、sigID、地址或枚举…"
            />
          </div>
          <div class="inline">
            <span class="muted">{{ filtered.length }} 条</span
            ><button
              v-if="board && sheet.entity === 'data_items'"
              class="button small"
              @click="emit('settings')"
            >
              项目共享目录 <ArrowRight :size="15" /></button
            ><button
              v-if="canCreate"
              class="button primary small"
              @click="create()"
            >
              <Plus :size="16" />新建{{ spec.label }}
            </button>
          </div>
        </div>
        <div class="table-scroll sheet-scroll">
          <table :aria-label="sheet.label">
            <thead>
              <tr>
                <th class="row-number">#</th>
                <th v-for="key in columns" :key="key">
                  {{ captions[key] || key }}
                </th>
                <th v-if="spec || sheet.entity === 'source_records'">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(r, index) in visible"
                :key="r.id || `${r.route_id}:${r.field_id}`"
              >
                <td class="row-number">{{ (page - 1) * 50 + index + 1 }}</td>
                <td v-for="(key, i) in columns" :key="key">
                  <button
                    v-if="i === 0 && spec"
                    class="text-button record-name"
                    :title="cell(r, key)"
                    @click="open(r)"
                  >
                    {{ cell(r, key) }}</button
                  ><span
                    v-else
                    :class="{
                      mono: [
                        'resolved_sig_id',
                        'enum_name',
                        'effective_address',
                        'register_address',
                      ].includes(key),
                    }"
                    >{{ cell(r, key) }}</span
                  >
                </td>
                <td v-if="spec">
                  <div class="inline">
                    <button
                      v-if="r.source_sheet && sourceOf(r)"
                      class="icon-btn"
                      aria-label="查看来源单元格"
                      @click="showSource(sourceOf(r))"
                    >
                      <FileSpreadsheet :size="17" /></button
                    ><button
                      class="icon-btn"
                      :aria-label="`查看 ${r.name || r.signal_name || r.id} 的配置`"
                      @click="open(r)"
                    >
                      <ChevronRight :size="17" />
                    </button>
                  </div>
                </td>
                <td v-else-if="sheet.entity === 'source_records'">
                  <button class="text-button" @click="showSource(r)">
                    查看单元格与公式
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Empty
          v-if="!visible.length"
          title="当前表格暂无匹配记录"
          :detail="
            sheet.role === 'client'
              ? '此板卡的采集绑定会显示在这里。'
              : sheet.role === 'server'
                ? '此板卡的普通转发绑定会显示在这里；地址段透传单独配置。'
                : '调整搜索，或添加当前板卡需要的配置。'
          "
        />
        <div class="pagination">
          <span>共 {{ filtered.length }} 条 · 每页 50 条</span>
          <div class="inline">
            <button
              class="icon-btn"
              :disabled="page <= 1"
              aria-label="上一页"
              @click="page--"
            >
              <ChevronLeft :size="18" /></button
            ><span>{{ page }} / {{ pages }}</span
            ><button
              class="icon-btn"
              :disabled="page >= pages"
              aria-label="下一页"
              @click="page++"
            >
              <ChevronRight :size="18" />
            </button>
          </div>
        </div>
      </template>
    </section>
  </template>
  <ChangeEditor
    v-if="edit && graph"
    :key="`${edit.entity}:${edit.row?.id || 'new'}`"
    :pid="pid"
    :graph="graph"
    :entity="edit.entity"
    :row="edit.row"
    :defaults="edit.defaults"
    :board="board"
    :binding-role="edit.role"
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
      <pre class="source-json">{{ JSON.stringify(source.cells, null, 2) }}</pre>
    </div></Modal
  >
</template>

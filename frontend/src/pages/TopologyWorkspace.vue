<script setup lang="ts">
import { ref, watch, computed, onBeforeUnmount } from "vue";
import { api, type Row } from "../api";
import { specs, labels, labelFor } from "../domain/schema";
import {
  boardSheets,
  configuredBoardSheets,
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
import { pointGroupLabel, type PointSchema } from "../domain/pointTables";
import { pageSizeOptions, usePageSize } from "../composables/usePageSize";
import { usePermissionContext } from "../composables/useProjectPermissions";
import { allowsEntity, allowsScope } from "../domain/permissions";
const props = defineProps<{
  pid: number;
  graph: Row | null;
  canWrite: boolean;
  mode: "board" | "settings";
  boardId: number;
  focus?: Row | null;
}>();
const emit = defineEmits<{
  done: [merged?: boolean];
  conflict: [];
  error: [message: string];
  board: [id: number];
  settings: [];
  configuration: [];
  sheet: [label: string];
  dirty: [value: boolean];
}>();
const pointDirty = ref(false);
const permissions = usePermissionContext();
watch(pointDirty, value => emit("dirty", value), {flush:"sync"});
onBeforeUnmount(() => emit("dirty", false));
function selectSheet(key:string) {
  if (key === sheet.value.key) return;
  if (pointDirty.value && !window.confirm("有未保存的修改，是否放弃并切换表格？")) return;
  pointDirty.value = false;
  sheetKey.value = key;
  query.value = "";
  pointFocus.value = undefined;
}
const types = computed(() => boardTypes(props.graph));
const board = computed(() =>
  props.mode === "board"
    ? types.value.find((t) => t.id === props.boardId)
    : undefined,
);
const boardModel = computed(() =>
  props.graph?.board_models.find((m: Row) => m.id === board.value?.model_id),
);
const nativeBoard = computed(() => board.value?.point_storage === "native");
const nativeGroups = computed<Row[]>(() => nativeBoard.value ? board.value?.point_groups || [] : []);
const groupKey = ref<string>();
const groupId = ref<number>();
const groups = computed<Row[]>(() => props.mode === "board" && !nativeBoard.value
  ? rows(props.graph || {}, "signal_groups").filter(g => g.model_id === board.value?.model_id)
  : []);
let groupModelId: number | undefined;
watch([groups, () => board.value?.model_id], ([available, modelId]) => {
  // A successful commit briefly clears graph while reloading; retain this group's selection.
  if (!props.graph || modelId == null) return;
  if (modelId !== groupModelId) {
    groupModelId = modelId;
    groupId.value = available[0]?.id;
  } else if (groupId.value != null && !available.some(g => g.id === groupId.value)) {
    groupId.value = available[0]?.id;
  }
}, { immediate: true });
let nativeGroupModelId: number | undefined;
watch([nativeGroups, () => board.value?.model_id], ([available, modelId]) => {
  if (!props.graph || modelId == null) return;
  if (modelId !== nativeGroupModelId) {
    nativeGroupModelId = modelId;
    groupKey.value = available[0]?.code;
  } else if (groupKey.value != null && !available.some(group => group.code === groupKey.value)) {
    groupKey.value = available[0]?.code;
  }
}, { immediate: true });
const groupContexts = computed(() => rows(props.graph || {}, "device_contexts")
  .filter(c => groupId.value != null && c.group_id === groupId.value));
function selectGroup(id?: number) {
  if (id === groupId.value) return;
  if (pointDirty.value && !window.confirm("有未保存的修改，是否放弃并切换点表分组？")) return;
  pointDirty.value = false;
  groupId.value = id;
  pointFocus.value = undefined;
  query.value = "";
}
function selectNativeGroup(code?: string) {
  if (code === groupKey.value) return;
  if (pointDirty.value && !window.confirm("有未保存的修改，是否放弃并切换点表分组？")) return;
  pointDirty.value = false;
  groupKey.value = code;
  pointFocus.value = undefined;
  query.value = "";
}
function typeSignals(type: Row) {
  if (type.point_storage === "native") return rows(props.graph || {}, "process_points").filter(point => point.board_key === type.code).length;
  return (
    props.graph?.v_signals.filter((s: Row) => s.model_id === type.model_id)
      .length || 0
  );
}
const sheetKey = ref(props.mode === "settings" ? "models" : "signals"),
  query = ref(""),
  page = ref(1);
const pointFocus = ref<number>();
const displaySchema = ref<PointSchema | null>(null),
  schemaError = ref(""),
  schemaReload = ref(0);
const displayError = computed(() => {
  if (schemaError.value) return schemaError.value;
  const code = board.value?.code;
  if (props.mode === "board" && displaySchema.value && code &&
      (!displaySchema.value.boards[code] || !displaySchema.value.workspace.boards[code])) {
    return `项目目录缺少板卡 ${code} 的表格定义，请检查 project.json 中的目录配置。`;
  }
  return "";
});
watch(
  () => [props.pid, props.mode, schemaReload.value],
  async (_, __, cleanup) => {
    let cancelled = false;
    cleanup(() => {
      cancelled = true;
    });
    displaySchema.value = null;
    schemaError.value = "";
    if (props.mode !== "board") return;
    try {
      const result = await api(`/projects/${props.pid}/point-tables/schema`);
      if (!cancelled) displaySchema.value = result;
    } catch (e) {
      if (!cancelled) schemaError.value = (e as Error).message;
    }
  },
  { immediate: true },
);
const edit = ref<{
    entity: string;
    row: Row | null;
    defaults?: Row;
    role?: string;
  } | null>(null),
  source = ref<Row | null>(null);
const sheets = computed(() =>
  props.mode === "settings"
    ? projectSheets
    : displaySchema.value
      ? configuredBoardSheets(displaySchema.value, board.value?.code || "")
      : [],
);
const sheet = computed<Sheet>(
  () =>
    sheets.value.find((s) => s.key === sheetKey.value) ||
    sheets.value[0] ||
    boardSheets[0],
);
watch(
  sheets,
  (available) => {
    if (!available.some((s) => s.key === sheetKey.value))
      sheetKey.value = available[0]?.key || "";
  },
  { immediate: true },
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
  () => [props.graph, props.focus, displaySchema.value],
  () => {
    if (!props.graph || !props.focus) return;
    if (props.mode === "board" && !displaySchema.value) return;
    const nativeKind = nativeBoard.value
      ? ({ process_points: "process", transmit_points: "forward", collect_points: "collect" } as Record<string, string>)[props.focus.entity]
      : undefined;
    const target = nativeKind ? sheets.value.find(item => item.pointKind === nativeKind)
      : (props.mode === "settings" ? projectSheets : boardSheets).find(
      (s) =>
        s.entity === props.focus!.entity &&
        (!s.role ||
          props.graph!.v_bindings.find((b: Row) => b.id === props.focus!.id)
            ?.role === s.role),
    );
    if (target && sheets.value.some((s) => s.key === target.key)) {
      sheetKey.value = target.key;
      if (target.pointKind) {
        edit.value = null;
        if (nativeBoard.value) {
          const pointId = target.pointKind === "process" ? props.focus.id
            : rows(props.graph, target.pointKind === "forward" ? "transmit_points" : "collect_points").find(point => point.id === props.focus!.id)?.process_point_id;
          groupKey.value = rows(props.graph, "process_points").find(point => point.id === pointId)?.group_key;
          pointFocus.value = props.focus.id;
          return;
        }
        const signalId = target.pointKind === "process" ? props.focus.id
          : props.graph.signal_bindings.find((b: Row) => b.id === props.focus!.id)?.signal_id;
        groupId.value = props.graph.signals.find((s: Row) => s.id === signalId)?.group_id;
        pointFocus.value = props.focus.id;
        return;
      }
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
  () => (sheets.value.length ? sheet.value.label : ""),
  (label) => emit("sheet", label),
  { immediate: true },
);
watch([sheetKey, query], () => (page.value = 1));
function entries(s: Sheet): Row[] {
  if (!props.graph) return [];
  if (nativeBoard.value && s.pointKind) {
    const points = rows(props.graph, "process_points").filter(point => point.board_key === board.value?.code);
    if (s.pointKind === "process") return points.filter(point => groupKey.value == null || point.group_key === groupKey.value);
    const ids = new Set(points.filter(point => groupKey.value == null || point.group_key === groupKey.value).map(point => point.id));
    return rows(props.graph, s.pointKind === "forward" ? "transmit_points" : "collect_points")
      .filter(point => point.board_key === board.value?.code && ids.has(point.process_point_id));
  }
  if (s.entity === "type_connections")
    return typeConnections(props.graph).filter(
      (r) => r.parent === board.value?.code || r.child === board.value?.code,
    );
  let records = rows(props.graph, s.view || specs[s.entity]?.view || s.entity);
  records = scopedRows(props.graph, board.value, s.entity, records);
  if (s.role) records = records.filter((r) => r.role === s.role);
  if (s.pointKind && groupId.value != null) records = records.filter(r =>
    s.pointKind === "process" ? r.group_id === groupId.value
      : props.graph!.signals.some((p: Row) => p.id === r.signal_id && p.group_id === groupId.value));
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
const { pageSize, setPageSize } = usePageSize(computed(() => `table-page-size:${props.pid}:${props.mode}:${props.boardId}:${sheet.value.key}`));
const pages = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / pageSize.value)),
);
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
);
watch(pages, (n) => (page.value = Math.min(page.value, n)));
function changePageSize(event: Event) {
  const select = event.target as HTMLSelectElement;
  const firstRow = (page.value - 1) * pageSize.value;
  const size = Number(select.value);
  if (setPageSize(size)) page.value = Math.min(pages.value, Math.floor(firstRow / size) + 1);
  select.value = String(pageSize.value);
}
const canCreate = computed(
  () =>
    props.canWrite &&
    !!spec.value &&
    !(props.mode === "board" && sheet.value.entity === "data_items") && canCreateScope(),
);
function canCreateScope() {
  if (permissions.state.value?.can_manage_project) return true;
  const modelId = board.value?.model_id;
  if (!modelId || !props.graph) return false;
  const entity = sheet.value.entity;
  if (["signal_groups", "device_contexts", "signals", "signal_ranges"].includes(entity))
    return allowsScope(permissions.state.value, { model_id: modelId, scope: "internal" });
  if (entity === "endpoints") return allowsScope(permissions.state.value, { model_id: modelId, scope: "board" }) || props.graph.endpoints.some((endpoint: Row) => endpoint.model_id === modelId && allowsEntity(permissions.state.value, props.graph!, entity, endpoint));
  if (entity === "protocol_fields") return props.graph.endpoints.some((endpoint: Row) => endpoint.model_id === modelId && allowsEntity(permissions.state.value, props.graph!, entity, { contract_id: endpoint.contract_id }));
  if (entity === "passthrough_routes") return ["client", "server"].every(role => props.graph!.endpoints.some((endpoint: Row) => endpoint.model_id === modelId && endpoint.role === role && allowsEntity(permissions.state.value, props.graph!, "endpoints", endpoint)));
  return false;
}
function canEditEntity(entity: string, row?: Row | null) {
  return props.canWrite && !!props.graph && allowsEntity(permissions.state.value, props.graph, entity, row);
}
function open(row: Row) {
  if (!spec.value) return;
  edit.value = {
    entity: sheet.value.entity,
    row: props.graph![sheet.value.entity].find((r: Row) => r.id === row.id),
    role: sheet.value.role,
  };
}
function create(entity = sheet.value.entity) {
  if (!canCreate.value) return;
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
        (e: Row) => e.model_id === b.model_id && allowsEntity(permissions.state.value, g, "protocol_fields", { contract_id: e.contract_id }),
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
function done(record: Row, merged = false) {
  const entering = edit.value?.entity === "boards" && !edit.value.row;
  edit.value = null;
  emit("done", merged);
  if (entering) emit("board", record.id);
}
function pointDone(merged = false) {
  pointFocus.value = undefined;
  emit("done", merged);
}
function openProcess(id: number) {
  if (sheets.value.some((s) => s.pointKind === "process")) {
    if (nativeBoard.value) groupKey.value = rows(props.graph || {}, "process_points").find(point => point.id === id)?.group_key;
    else groupId.value = props.graph?.signals.find((r: Row) => r.id === id)?.group_id;
    sheetKey.value = "signals";
    pointFocus.value = id;
  } else {
    const row = props.graph?.signals.find((r: Row) => r.id === id);
    if (row) edit.value = { entity: "signals", row };
  }
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
    detail="在服务器项目文件中定义板卡类型，检查并导入后维护点表。"
    ><button class="button" @click="emit('configuration')">
      项目拓扑配置
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
        :title="`${type.name} · ${typeSignals(type)} 个信号`"
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
    <div v-if="displayError" class="notice danger" role="alert">
      {{ displayError }}
      <button class="text-button" @click="schemaReload++">重试</button>
    </div>
    <Loading v-else-if="mode === 'board' && !displaySchema" />
    <Empty
      v-else-if="!sheets.length"
      title="此板卡暂无展示表格"
      detail="当前板卡未配置需要显示的表格。"
    />
    <section v-else class="panel table-panel board-tables">
      <div v-if="nativeBoard && nativeGroups.length" class="point-groups" role="group" aria-label="点表分组">
        <span>点表分组</span>
        <button v-for="group in nativeGroups" :key="group.code" class="button small"
          :class="{ primary: groupKey === group.code }" :aria-pressed="groupKey === group.code"
          @click="selectNativeGroup(group.code)">{{ group.code }} · {{ group.name }}</button>
        <button v-if="nativeGroups.length > 1" class="button small" :aria-pressed="groupKey == null" @click="selectNativeGroup()">全部分组</button>
      </div>
      <div v-if="board && groups.length" class="point-groups" role="group" aria-label="点表分组">
        <span>点表分组</span>
        <button v-for="g in groups" :key="g.id" class="button small"
          :class="{ primary: groupId === g.id }" :aria-pressed="groupId === g.id"
          @click="selectGroup(g.id)">{{ pointGroupLabel(g) }}</button>
        <button class="button small" :aria-pressed="groupId == null" @click="selectGroup()">全部分组</button>
        <span v-if="sheet.pointKind && groupContexts.length" class="point-group-contexts"
          :title="`使用此组的设备：${groupContexts.map(c => `${c.name} [${c.dev_id}]`).join('、')}。点定义和范围共用；采集、转发按设备分别配置。`">
          使用此组的设备：{{ groupContexts.map(c => `${c.name} [${c.dev_id}]`).join('、') }}
        </span>
      </div>
      <div
        class="entity-tabs"
        role="tablist"
        :aria-label="board ? '板卡内表格' : '项目共享配置'"
      >
        <button
          v-for="s in sheets"
          :key="s.key"
          role="tab"
          :aria-selected="sheetKey === s.key"
          :class="{ selected: sheetKey === s.key }"
          @click="selectSheet(s.key)"
        >
          {{ s.label }}<small>{{ entries(s).length }}</small>
        </button>
      </div>
      <PointTable
        v-if="sheet.pointKind && board && graph"
        :key="`${board.model_id}:${sheet.pointKind}:${nativeBoard ? groupKey ?? 'all' : groupId ?? 'all'}`"
        :pid="pid"
        :model-id="board.model_id"
        :kind="sheet.pointKind"
        :label="sheet.label"
        :revision="graph.revision"
        :can-write="canWrite"
        :process-enabled="boardModel?.firmware_profile === 'aidc'"
        :focus-id="pointFocus"
        :group-id="nativeBoard ? undefined : groupId"
        :group-key="nativeBoard ? groupKey : undefined"
        :allow-forward="sheets.some(s => s.pointKind === 'forward')"
        :forward-label="sheets.find(s => s.pointKind === 'forward')?.label"
        @done="pointDone"
        @conflict="emit('conflict')"
        @process="openProcess"
        @error="emit('error', $event)"
        @dirty="pointDirty = $event"
      />
      <template v-else>
        <div class="sheet-heading">
          <h2>{{ sheet.label }}</h2>
          <span v-if="sheet.role">{{
            sheet.role === "client"
              ? "从协议端点采集到本板内部信号"
              : "将本板内部信号映射到对外协议字段"
          }}</span
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
            >挂载关系及协议通过 SSH 在服务器 project.json
            中维护；同一关系可有多种协议，挂载数量不叠加。</span
          ><button class="text-button" @click="emit('configuration')">
            项目拓扑配置 <ArrowRight :size="15" />
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
                <td class="row-number">{{ (page - 1) * pageSize + index + 1 }}</td>
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
          <div class="inline pagination-summary">
            <span>共 {{ filtered.length }} 条</span>
            <label class="page-size-control">每页
              <select :value="pageSize" aria-label="每页条数" @change="changePageSize">
                <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option>
              </select>条
            </label>
          </div>
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
    :can-write="edit.row ? canEditEntity(edit.entity, edit.row) : canCreate"
    @close="edit = null"
    @done="done"
    @error="emit('error', $event)"
    @conflict="edit = null; emit('conflict')"
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

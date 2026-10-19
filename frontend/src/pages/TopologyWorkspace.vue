<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Box } from "@lucide/vue";
import { api, type Row } from "../api";
import { boardTypes } from "../domain/project";
import { configuredBoardSheets, rows } from "../domain/board";
import type { PointKind, PointSchema } from "../domain/pointTables";
import Loading from "../components/Loading.vue";
import Empty from "../components/Empty.vue";
import PointTable from "../components/PointTable.vue";
const props = defineProps<{
  pid: number;
  graph: Row | null;
  canWrite: boolean;
  boardKey: string;
  focus?: Row | null;
}>();
const emit = defineEmits<{
  done: [merged?: boolean];
  conflict: [];
  error: [message: string];
  board: [key: string];
  configuration: [];
  sheet: [label: string];
  dirty: [value: boolean];
}>();
const types = computed(() => boardTypes(props.graph));
const board = computed(() => types.value.find(type => type.code === props.boardKey));
const enabled = computed(() => board.value?.point_storage === "native");
const groups = computed<Row[]>(() => enabled.value ? board.value?.point_groups || [] : []);
const groupKey = ref<string>();
const sheetKey = ref<PointKind>("process");
const pointFocus = ref<number>();
const pointDirty = ref(false);
const schema = ref<PointSchema | null>(null), error = ref(""), reload = ref(0);
watch(pointDirty, value => emit("dirty", value), { flush: "sync" });
onBeforeUnmount(() => emit("dirty", false));
watch(() => [props.pid, reload.value], async (_, __, cleanup) => {
  let cancelled = false;
  cleanup(() => { cancelled = true; });
  schema.value = null;
  error.value = "";
  try {
    const result = await api(`/projects/${props.pid}/point-tables/schema`);
    if (!cancelled) schema.value = result;
  } catch (cause) {
    if (!cancelled) error.value = (cause as Error).message;
  }
}, { immediate: true });
let selectedBoard: string | undefined;
watch([groups, () => board.value?.code], ([available, code]) => {
  if (!props.graph || !code) return;
  if (code !== selectedBoard) {
    selectedBoard = code;
    groupKey.value = available[0]?.code;
    sheetKey.value = "process";
    pointFocus.value = undefined;
  } else if (groupKey.value != null && !available.some(group => group.code === groupKey.value)) {
    groupKey.value = available[0]?.code;
  }
}, { immediate: true });
const sheets = computed(() => enabled.value && schema.value
  ? configuredBoardSheets(schema.value, props.boardKey) : []);
const sheet = computed(() => sheets.value.find(item => item.key === sheetKey.value) || sheets.value[0]);
watch(sheets, available => {
  if (available.length && !available.some(item => item.key === sheetKey.value)) sheetKey.value = available[0].key;
}, { immediate: true });
watch(() => sheet.value?.label || "", label => emit("sheet", label), { immediate: true });
const points = computed(() => rows(props.graph || {}, "process_points").filter(point => point.board_key === props.boardKey));
function count(kind: PointKind) {
  const selected = points.value.filter(point => groupKey.value == null || point.group_key === groupKey.value);
  if (kind === "process") return selected.length;
  const ids = new Set(selected.map(point => point.id));
  return rows(props.graph || {}, "transmit_points").filter(point => point.board_key === props.boardKey && ids.has(point.process_point_id)).length;
}
function leaveTable() {
  if (pointDirty.value && !window.confirm("有未保存的点表修改，是否放弃？")) return false;
  pointDirty.value = false;
  pointFocus.value = undefined;
  return true;
}
function selectGroup(code?: string) {
  if (code !== groupKey.value && leaveTable()) groupKey.value = code;
}
function selectSheet(kind: PointKind) {
  if (kind !== sheetKey.value && leaveTable()) sheetKey.value = kind;
}
function openProcess(id: number) {
  if (!sheets.value.some(item => item.key === "process")) return;
  groupKey.value = points.value.find(point => point.id === id)?.group_key;
  sheetKey.value = "process";
  pointFocus.value = id;
}
watch([() => props.focus, () => props.graph, sheets], () => {
  if (!props.focus || !props.graph || !enabled.value) return;
  const kind = props.focus.entity === "process_points" ? "process"
    : props.focus.entity === "transmit_points" ? "forward" : null;
  if (!kind || !sheets.value.some(item => item.key === kind)) return;
  const record = rows(props.graph, props.focus.entity).find(item => item.id === props.focus!.id);
  if (!record || record.board_key !== props.boardKey) return;
  const point = kind === "process" ? record : points.value.find(item => item.id === record.process_point_id);
  groupKey.value = point?.group_key;
  sheetKey.value = kind;
  pointFocus.value = record.id;
}, { immediate: true });
function done(merged = false) {
  pointFocus.value = undefined;
  emit("done", merged);
}
</script>
<template>
  <Loading v-if="!graph" />
  <Empty v-else-if="!board" title="先配置板卡类型" detail="通过服务器项目文件或文件夹导入配置板卡。">
    <button class="button" @click="emit('configuration')">项目拓扑配置</button>
  </Empty>
  <template v-else>
    <div class="board-type-selector" role="group" aria-label="选择板卡类型">
      <button v-for="type in types" :key="type.code"
        :class="['board-type-choice', { selected: type.code === boardKey }]"
        :aria-label="`选择 ${type.code} 板卡`" :aria-pressed="type.code === boardKey"
        @click="emit('board', type.code)">
        <Box :size="21" />
        <div><strong>{{ type.code }}</strong><span>{{ type.name }}</span></div>
        <small>{{ type.point_storage === 'native' ? `${rows(graph, 'process_points').filter(point => point.board_key === type.code).length} 个内部点` : '点表暂未启用' }}</small>
      </button>
    </div>
    <Empty v-if="!enabled" title="此板卡点表暂未启用" detail="当前阶段维护 DSP 内部数据和转发表，此板卡的组成与连接由项目 JSON 定义。" />
    <div v-else-if="error" class="notice danger" role="alert">{{ error }} <button class="text-button" @click="reload++">重试</button></div>
    <Loading v-else-if="!schema" />
    <Empty v-else-if="!sheet" title="此板卡暂无展示表格" detail="请检查项目文件中的表格定义和展示配置。" />
    <section v-else class="panel table-panel board-tables">
      <div v-if="groups.length" class="point-groups" role="group" aria-label="点表分组">
        <span>点表分组</span>
        <button v-for="group in groups" :key="group.code" class="button small"
          :class="{ primary: groupKey === group.code }" :aria-pressed="groupKey === group.code"
          @click="selectGroup(group.code)">{{ group.code }} · {{ group.name }}</button>
        <button v-if="groups.length > 1" class="button small" :aria-pressed="groupKey == null" @click="selectGroup()">全部分组</button>
      </div>
      <div class="entity-tabs" role="tablist" aria-label="板卡内表格">
        <button v-for="item in sheets" :key="item.key" role="tab"
          :aria-selected="sheet.key === item.key" :class="{ selected: sheet.key === item.key }"
          @click="selectSheet(item.key)">{{ item.label }}<small>{{ count(item.pointKind) }}</small></button>
      </div>
      <PointTable :key="`${boardKey}:${sheet.key}:${groupKey ?? 'all'}`" :pid="pid" :board-key="boardKey"
        :kind="sheet.pointKind" :label="sheet.label" :revision="graph.revision" :can-write="canWrite"
        :focus-id="pointFocus" :group-key="groupKey" :allow-forward="sheets.some(item => item.key === 'forward')"
        :forward-label="sheets.find(item => item.key === 'forward')?.label"
        @done="done" @conflict="emit('conflict')" @process="openProcess" @error="emit('error', $event)" @dirty="pointDirty = $event" />
    </section>
  </template>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api, type Row } from "../api";
import {
  pointText,
  type PointKind,
  type PointTableData,
} from "../domain/pointTables";
import { Search, Plus, ChevronLeft, ChevronRight } from "@lucide/vue";
import Loading from "./Loading.vue";
import Empty from "./Empty.vue";
import PointEditor from "./PointEditor.vue";
const props = defineProps<{
  pid: number;
  modelId: number;
  kind: PointKind;
  revision: number;
  canWrite: boolean;
  processEnabled: boolean;
  focusId?: number;
}>();
const emit = defineEmits<{
  done: [];
  process: [id: number];
  error: [message: string];
}>();
const data = ref<PointTableData | null>(null),
  error = ref(""),
  query = ref(""),
  page = ref(1);
const filter = ref<number | "">("");
const editing = ref(false),
  selected = ref<Row | null>(null);
const reload = ref(0);
watch(
  () => [props.pid, props.modelId, props.kind, props.revision, reload.value],
  async (_, __, cleanup) => {
    let cancelled = false;
    cleanup(() => {
      cancelled = true;
    });
    data.value = null;
    error.value = "";
    editing.value = false;
    try {
      const result = await api(
        `/projects/${props.pid}/board-models/${props.modelId}/point-tables/${props.kind}`,
      );
      if (!cancelled) data.value = result;
    } catch (e) {
      if (!cancelled) error.value = (e as Error).message;
    }
  },
  { immediate: true },
);
watch(
  () => [data.value, props.focusId],
  () => {
    const row = data.value?.rows.find((r) => r.id === props.focusId);
    if (row) open(row);
  },
);
const def = computed(() => data.value?.definition);
const indexed = computed(() =>
  (data.value?.rows || []).map((row) => ({
    row,
    search: def
      .value!.columns.map((key) => pointText(row[key]))
      .join(" ")
      .toLowerCase(),
  })),
);
const filtered = computed(() =>
  indexed.value
    .filter(
      ({ row, search }) =>
        (!filter.value ||
          row[props.kind === "process" ? "group_id" : "context_id"] ===
            filter.value) &&
        search.includes(query.value.trim().toLowerCase()),
    )
    .map(({ row }) => row),
);
const pages = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / 50)),
);
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * 50, page.value * 50),
);
watch([query, filter], () => {
  page.value = 1;
});
watch(pages, (n) => {
  page.value = Math.min(page.value, n);
});
function open(row: Row | null) {
  selected.value = row;
  editing.value = true;
}
function text(row: Row, key: string) {
  if (key === "upp_model" && row.protocol !== "UPP") return "—";
  return pointText(row[key]);
}
</script>
<template>
  <div v-if="error" class="notice danger" role="alert">
    {{ error }} <button class="text-button" @click="reload++">重试</button>
  </div>
  <Loading v-else-if="!data || !def" />
  <template v-else>
    <div class="sheet-heading">
      <h2>{{ def.label }}</h2>
      <span>{{ def.description }}</span>
    </div>
    <div class="table-toolbar">
      <div class="search">
        <Search :size="17" /><input
          v-model="query"
          aria-label="搜索当前表格"
          placeholder="搜索名称、sigID、地址或枚举…"
        />
      </div>
      <select
        v-model="filter"
        class="point-filter"
        :aria-label="kind === 'process' ? '筛选信号组' : '筛选逻辑设备'"
      >
        <option value="">
          {{ kind === "process" ? "全部信号组" : "全部逻辑设备" }}
        </option>
        <option
          v-for="o in data.options[kind === 'process' ? 'groups' : 'contexts']"
          :key="o.id"
          :value="o.id"
        >
          {{ o.name }}
        </option>
      </select>
      <div class="inline">
        <span class="muted">{{ filtered.length }} 条</span
        ><button
          v-if="canWrite"
          class="button primary small"
          @click="open(null)"
        >
          <Plus :size="16" />新建{{ def.label }}
        </button>
      </div>
    </div>
    <div class="table-scroll sheet-scroll">
      <table :aria-label="def.label">
        <thead>
          <tr>
            <th class="row-number">#</th>
            <th v-for="key in def.columns" :key="key">
              {{ def.fields[key].column_label || def.fields[key].label }}
            </th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in visible" :key="row.id">
            <td class="row-number">{{ (page - 1) * 50 + i + 1 }}</td>
            <td v-for="(key, j) in def.columns" :key="key">
              <button
                v-if="j === 0"
                class="text-button record-name"
                @click="open(row)"
              >
                {{ text(row, key) }}
              </button>
              <span
                v-else
                :title="
                  kind === 'process' &&
                  ['default_value', 'min_value', 'max_value'].includes(key)
                    ? row.edit_values[key] == null
                      ? '继承数据定义'
                      : '处理点覆盖值'
                    : undefined
                "
                >{{ text(row, key) }}</span
              >
            </td>
            <td>
              <button
                v-if="kind !== 'process'"
                class="text-button"
                @click="emit('process', row.signal_id)"
              >
                关联处理点</button
              ><button v-else class="text-button" @click="open(row)">
                配置与范围
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <Empty
      v-if="!visible.length"
      title="当前表格暂无匹配记录"
      detail="调整筛选，或添加当前板卡需要的点表配置。"
    />
    <div class="pagination">
      <span>共 {{ filtered.length }} 条 · 每页 50 条</span>
      <div class="inline">
        <button
          class="icon-btn"
          aria-label="上一页"
          :disabled="page <= 1"
          @click="page--"
        >
          <ChevronLeft :size="18" /></button
        ><span>{{ page }} / {{ pages }}</span>
        <button
          class="icon-btn"
          aria-label="下一页"
          :disabled="page >= pages"
          @click="page++"
        >
          <ChevronRight :size="18" />
        </button>
      </div>
    </div>
    <PointEditor
      v-if="editing"
      :key="selected?.id || 'new'"
      :pid="pid"
      :model-id="modelId"
      :data="data"
      :row="selected"
      :can-write="canWrite"
      :process-enabled="processEnabled"
      @close="editing = false"
      @done="
        editing = false;
        emit('done');
      "
    />
  </template>
</template>

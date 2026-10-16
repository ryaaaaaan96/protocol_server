<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { api, revisionConflict, type Row } from "../api";
import {
  choiceLabel,
  pointChoices,
  pointText,
  type PointTableData,
} from "../domain/pointTables";
import Modal from "./Modal.vue";
import Field from "./Field.vue";
const props = defineProps<{
  pid: number;
  modelId: number;
  data: PointTableData;
  row: Row | null;
  canWrite: boolean;
  processEnabled: boolean;
  groupId?: number;
  signalId?: number;
  contextId?: number;
}>();
const emit = defineEmits<{ close: []; done: [merged?: boolean]; error: [message: string]; conflict: []; dirty: [value: boolean] }>();
const def = props.data.definition;
const values = ref<Row>({});
for (const key of def.editor) {
  const f = def.fields[key];
  values.value[key] =
    props.row && Object.hasOwn(props.row.edit_values, key)
      ? props.row.edit_values[key]
      : (f.default ??
        (f.nullable || f.reference || f.type === "number"
          ? null
          : f.type === "boolean"
            ? false
            : ""));
}
if (!props.row) {
  if (props.data.kind === "process") {
    values.value.group_id = props.groupId ?? props.data.options.groups[0]?.id ?? null;
    values.value.process_enabled = props.processEnabled;
  } else {
    values.value.endpoint_id =
      pointChoices(props.data, "endpoint_id", values.value)[0]?.id ?? null;
    values.value.context_id =
      props.contextId ?? pointChoices(props.data, "context_id", values.value)[0]?.id ?? null;
    if (props.signalId != null) values.value.signal_id = props.signalId;
  }
}
const initial: Row = JSON.parse(JSON.stringify(values.value));
const preview = ref<Row | null>(null),
  busy = ref(false),
  error = ref("");
const operation = ref(props.row ? "update" : "create");
const dirty = computed(() => JSON.stringify(values.value) !== JSON.stringify(initial));
watch(dirty, value => emit("dirty", value), { immediate: true, flush: "sync" });
onBeforeUnmount(() => emit("dirty", false));
function close() {
  if (busy.value) return;
  if (dirty.value && !window.confirm("有未保存的修改，是否放弃？")) return;
  emit("close");
}
function locked(key: string) {
  return (key === "group_id" && props.groupId != null) || (key === "signal_id" && props.signalId != null);
}
const inherited = computed(() =>
  props.data.options.data.find((d) => d.id === values.value.data_item_id),
);
function choices(key: string) {
  return pointChoices(props.data, key, values.value);
}
function set(key: string, event: Event) {
  const f = def.fields[key],
    input = event.target as HTMLInputElement;
  values.value[key] =
    f.type === "boolean"
      ? input.checked
      : input.value === "" && (f.nullable || f.reference || f.type === "number")
        ? null
        : f.type === "number"
          ? Number(input.value)
          : input.value;
  preview.value = null;
  error.value = "";
  if (f.reference) {
    for (let pass = 0; pass < 2; pass++)
      for (const k of def.editor)
        if (
          def.fields[k].reference &&
          values.value[k] != null &&
          !choices(k).some((r) => r.id === values.value[k])
        )
          values.value[k] = null;
  }
}
async function review(op = props.row ? "update" : "create") {
  preview.value = null;
  error.value = "";
  busy.value = true;
  operation.value = op;
  try {
    const changed = Object.fromEntries(
      Object.entries(values.value).filter(
        ([k, v]) =>
          op === "create" || JSON.stringify(v) !== JSON.stringify(initial[k]),
      ),
    );
    if (op === "update" && !Object.keys(changed).length)
      throw new Error("请先修改需要调整的字段。");
    preview.value = await api(
      `/projects/${props.pid}/board-models/${props.modelId}/point-tables/${props.data.kind}/preview`,
      "POST",
      {
        revision: props.data.revision,
        operation: op,
        id: props.row?.id ?? null,
        values: op === "delete" ? {} : changed,
        expected: initial,
      },
    );
    if (preview.value && !preview.value.allowed) emit("error", preview.value.errors.map((e: Row) => e.message).join("；") || "关联检查未通过");
  } catch (e) {
    error.value = (e as Error).message;
    emit("error", error.value);
    if (revisionConflict(e)) emit("conflict");
  } finally {
    busy.value = false;
  }
}
async function commit() {
  busy.value = true;
  error.value = "";
  try {
    const result = await api(
      `/projects/${props.pid}/changes/${preview.value!.id}/commit`,
      "POST",
      {},
    );
    emit("done", !!(result.merged || preview.value?.merged));
  } catch (e) {
    error.value = (e as Error).message;
    emit("error", error.value);
    if (revisionConflict(e)) emit("conflict");
    preview.value = null;
  } finally {
    busy.value = false;
  }
}
function delta(change: Row): string {
  const a = change.after || {},
    b = change.before || {};
  return Object.keys({ ...b, ...a })
    .filter(
      (k) =>
        !["raw_json", "project_id"].includes(k) &&
        JSON.stringify(a[k]) !== JSON.stringify(b[k]),
    )
    .map(
      (k) =>
        `${def.fields[k]?.column_label || def.fields[k]?.label || k}: ${pointText(b[k])} → ${pointText(a[k])}`,
    )
    .join("；");
}
</script>
<template>
  <Modal
    :title="`${row ? (canWrite ? '编辑' : '查看') : '新建'}${def.label}`"
    wide
    @close="close"
  >
    <form @submit.prevent="review()">
      <div class="modal-body">
        <p class="muted">{{ def.description }}</p>
        <p v-if="data.kind === 'process' && values.group_id != null" class="notice">
          使用此组的设备：{{ data.options.contexts.filter(c => c.group_id === values.group_id).map(c => `${c.name} [${c.dev_id}]`).join('、') || '暂无' }}。
          点定义和范围修改会作用于这些设备。
        </p>
        <div
          v-if="data.kind === 'process' && inherited"
          class="notice point-inheritance"
        >
          继承默认值 {{ pointText(inherited.default_value) }}，下限
          {{ pointText(inherited.min_value) }}，上限
          {{ pointText(inherited.max_value) }}。
          留空覆盖字段即可恢复继承；范围规则作用于复用此处理点的所有设备上下文。
        </div>
        <div class="form-grid">
          <Field
            v-for="key in def.editor"
            :key="key"
            :label="def.fields[key].label"
            :hint="def.fields[key].hint"
          >
            <select
              v-if="def.fields[key].reference"
              :aria-label="def.fields[key].label"
              :value="values[key] ?? ''"
              :disabled="!canWrite || busy || locked(key)"
              :required="!def.fields[key].nullable"
              @change="set(key, $event)"
            >
              <option value="">请选择</option>
              <option v-for="r in choices(key)" :key="r.id" :value="r.id">
                {{ choiceLabel(r) }}
              </option>
            </select>
            <select
              v-else-if="def.fields[key].options"
              :aria-label="def.fields[key].label"
              :value="values[key] ?? ''"
              :disabled="!canWrite || busy"
              @change="set(key, $event)"
            >
              <option v-if="def.fields[key].nullable" value="">
                跟随数据定义
              </option>
              <option v-for="o in def.fields[key].options" :key="o" :value="o">
                {{ o }}
              </option>
            </select>
            <input
              v-else-if="def.fields[key].type === 'boolean'"
              type="checkbox"
              :aria-label="def.fields[key].label"
              :checked="!!values[key]"
              :disabled="!canWrite || busy"
              @change="set(key, $event)"
            />
            <input
              v-else
              :type="def.fields[key].type === 'number' ? 'number' : 'text'"
              :aria-label="def.fields[key].label"
              :value="values[key] ?? ''"
              :required="['name', 'enum_name'].includes(key)"
              :disabled="!canWrite || busy"
              @input="set(key, $event)"
            />
          </Field>
        </div>
        <div v-if="error" class="notice danger" role="alert">{{ error }}</div>
        <section v-if="preview" class="change-preview">
          <p v-if="preview.merged" class="notice">已合并其他成员的无关修改，请确认最新关联影响。</p>
          <h3>关联变更预览 · {{ preview.impact.count }} 项变化</h3>
          <div :class="['notice', { danger: !preview.allowed }]" role="status">
            {{
              preview.allowed
                ? "关联检查通过，可以提交。"
                : "此次修改会造成以下问题，已阻止提交。"
            }}
            <p v-for="(e, i) in preview.errors" :key="i">{{ e.message }}</p>
          </div>
          <p v-if="preview.impact.affected_types?.length">
            涉及板卡类型：{{
              preview.impact.affected_types.map((t: Row) => t.code).join("、")
            }}
          </p>
          <p v-if="preview.impact.affected_contexts?.length">涉及设备：{{ preview.impact.affected_contexts.map((c: Row) => `${c.name} [${c.dev_id}]`).join('、') }}</p>
          <div class="impact-list">
            <article v-for="(c, i) in preview.impact.changes" :key="i">
              <strong>{{
                c.after?.name || c.before?.name || c.after?.signal_name || c.key
              }}</strong>
              <p>{{ delta(c) }}</p>
            </article>
          </div>
          <p v-if="preview.impact.count > 200" class="muted">
            展示前 200 项变化；后端已检查全部关联。
          </p>
        </section>
      </div>
      <div class="modal-footer">
        <button
          v-if="row && canWrite"
          type="button"
          class="button danger-button"
          :disabled="busy"
          @click="review('delete')"
        >
          预览删除
        </button>
        <button
          type="button"
          class="button"
          :disabled="busy"
          @click="close"
        >
          关闭
        </button>
        <button v-if="canWrite" class="button" :disabled="busy">
          检查关联影响
        </button>
        <button
          v-if="canWrite && preview?.allowed"
          type="button"
          class="button primary"
          :disabled="busy"
          @click="commit"
        >
          确认{{ operation === "delete" ? "删除" : "提交" }}
        </button>
      </div>
    </form>
  </Modal>
</template>

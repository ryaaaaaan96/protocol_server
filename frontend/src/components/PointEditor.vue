<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { api, revisionConflict, type Row } from "../api";
import {
  choiceLabel,
  pointChoices,
  pointText,
  pointIsString,
  type PointTableData,
} from "../domain/pointTables";
import Modal from "./Modal.vue";
import Field from "./Field.vue";
import { usePermissionContext } from "../composables/useProjectPermissions";
import { allowsPoint, allowsScope } from "../domain/permissions";
const props = defineProps<{
  pid: number;
  modelId: number;
  data: PointTableData;
  row: Row | null;
  canWrite: boolean;
  processEnabled: boolean;
  groupId?: number;
  groupKey?: string;
  signalId?: number;
  contextId?: number;
}>();
const emit = defineEmits<{ close: []; done: [merged?: boolean]; error: [message: string]; conflict: []; dirty: [value: boolean] }>();
const def = props.data.definition;
const permissions = usePermissionContext();
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
  if (props.data.storage === "native") {
    if (props.data.kind === "process") {
      values.value.group_key = props.groupKey ?? props.data.options.native_groups?.[0]?.code ?? "LOCAL";
    } else if (props.signalId != null) {
      values.value.process_point_id = props.signalId;
    }
  } else if (props.data.kind === "process") {
    values.value.group_id = props.groupId ?? props.data.options.groups[0]?.id ?? null;
    values.value.process_enabled = props.processEnabled;
  } else {
    values.value.endpoint_id =
      choices("endpoint_id")[0]?.id ?? null;
    values.value.context_id =
      props.contextId ?? pointChoices(props.data, "context_id", values.value)[0]?.id ?? null;
    if (props.signalId != null) values.value.signal_id = props.signalId;
  }
}
const initial: Row = JSON.parse(JSON.stringify(values.value));
const scopeAllowed = computed(() => allowsPoint(permissions.state.value, props.modelId, props.data.kind, props.data, props.row));
const canSubmit = computed(() => props.canWrite && scopeAllowed.value && allowsPoint(permissions.state.value, props.modelId, props.data.kind, props.data, { edit_values: values.value }));
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
  return (key === "group_id" && props.groupId != null) ||
    (key === "group_key" && props.groupKey != null) ||
    (["signal_id", "process_point_id"].includes(key) && props.signalId != null);
}
const inherited = computed(() =>
  props.data.options.data?.find((d) => d.id === values.value.data_item_id),
);
const stringPoint = computed(() => pointIsString(props.data, values.value, props.row || undefined));
const editorFields = computed(() => def.editor.filter(key => !stringPoint.value || !["min_value", "max_value"].includes(key)));
function choices(key: string) {
  const options = pointChoices(props.data, key, values.value);
  return key === "endpoint_id" && props.canWrite
    ? options.filter(endpoint => allowsScope(permissions.state.value, { model_id: props.modelId, scope: "protocol", contract_id: endpoint.contract_id }))
    : options;
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
  if (["internal_type", "data_item_id"].includes(key) && stringPoint.value) {
    for (const bound of ["min_value", "max_value"])
      if (def.editor.includes(bound)) values.value[bound] = null;
  }
}
async function review(op = props.row ? "update" : "create") {
  if (!canSubmit.value || busy.value) return;
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
  if (!canSubmit.value || busy.value) return;
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
    lock-guard
    :title="`${row ? (canWrite ? '编辑' : '查看') : '新建'}${def.label}`"
    wide
    @close="close"
  >
    <form @submit.prevent="review()">
      <div class="modal-body">
        <p class="muted">{{ def.description }}</p>
        <p v-if="!scopeAllowed" class="notice">此记录不在你的板卡或协议编辑范围内，可以查看和复制。请联系管理员授权。</p>
        <p v-else-if="permissions.state.value?.edit_scope === 'scoped'" class="notice">修改名称、sigID、类型或共享字段可能影响关联板卡和协议，保存时需要覆盖全部受影响范围的权限。</p>
        <p v-if="data.kind === 'process' && values.group_id != null" class="notice">
          使用此组的设备：{{ data.options.contexts.filter(c => c.group_id === values.group_id).map(c => `${c.name} [${c.dev_id}]`).join('、') || '暂无' }}。
          点定义和范围修改会作用于这些设备。
        </p>
        <div
          v-if="data.kind === 'process' && inherited"
          class="notice point-inheritance"
        >
          继承默认值 {{ pointText(inherited.default_value) }}<template v-if="!stringPoint">，下限
          {{ pointText(inherited.min_value) }}，上限
          {{ pointText(inherited.max_value) }}</template>。
          <template v-if="stringPoint">字符串没有数值上下限，长度由字节数管理。</template>
          留空覆盖字段即可恢复继承；配置作用于复用此处理点的所有设备上下文。
        </div>
        <div class="form-grid">
          <Field
            v-for="key in editorFields"
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
                {{ data.storage === 'native' ? '未指定' : '跟随数据定义' }}
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
        <button v-if="canWrite" class="button" :disabled="busy || !canSubmit">
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

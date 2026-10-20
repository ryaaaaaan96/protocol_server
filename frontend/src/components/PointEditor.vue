<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { api, revisionConflict, type Row } from "../api";
import {
  choiceLabel,
  fieldApplies,
  pointChoices,
  pointChangeSummary,
  pointIsString,
  hasRecommendation,
  recommendationFields,
  communicationRecommendation,
  editableCommunicationRecommendation,
  communicationHint,
  communicationDiffers,
  type PointTableData,
} from "../domain/pointTables";
import Modal from "./Modal.vue";
import Field from "./Field.vue";
import PointWarnings from "./PointWarnings.vue";
import { usePermissionContext } from "../composables/useProjectPermissions";
import { allowsPoint, allowsScope } from "../domain/permissions";
const props = defineProps<{
  pid: number;
  boardKey: string;
  data: PointTableData;
  row: Row | null;
  canWrite: boolean;
  groupKey?: string;
  endpointKey?: string;
  processPointId?: number;
}>();
const emit = defineEmits<{ close: []; done: [merged?: boolean]; error: [message: string]; conflict: []; dirty: [value: boolean] }>();
const def = props.data.definition;
const permissions = usePermissionContext();
const values = ref<Row>({});
let communicationEdited = false;
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
    values.value.group_key = props.groupKey ?? props.data.options.native_groups?.[0]?.code ?? "LOCAL";
  } else {
    if (props.processPointId != null) values.value.process_point_id = props.processPointId;
    const endpoints = choices("endpoint_key");
    if (!endpoints.some(endpoint => endpoint.id === values.value.endpoint_key))
      values.value.endpoint_key = endpoints[0]?.id ?? null;
  }
}
if (!props.row && hasRecommendation(props.data)) Object.assign(values.value, editableCommunicationRecommendation(props.data, values.value));
const initial: Row = JSON.parse(JSON.stringify(values.value));
const scopeAllowed = computed(() => allowsPoint(permissions.state.value, props.boardKey, props.data.kind, props.data, props.row));
const canSubmit = computed(() => props.canWrite && scopeAllowed.value && allowsPoint(permissions.state.value, props.boardKey, props.data.kind, props.data, { edit_values: values.value }));
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
  return (key === "endpoint_key" && props.endpointKey != null) || (key === "group_key" && props.groupKey != null) ||
    (key === "process_point_id" && props.processPointId != null);
}
const stringPoint = computed(() => pointIsString(props.data, values.value, props.row || undefined));
const editorFields = computed(() => def.editor.filter(key => fieldApplies(props.data, key, values.value) && (!stringPoint.value || !["min_value", "max_value"].includes(key))));
const recommendation = computed(() => communicationRecommendation(props.data, values.value, props.row || undefined));
const recommendationHint = computed(() => communicationHint(props.data, values.value, props.row || undefined));
const recommendationDiffers = computed(() => communicationDiffers(props.data, values.value, props.row || undefined));
function applyRecommendation() {
  if (!canSubmit.value || busy.value || !recommendation.value) return;
  Object.assign(values.value, editableCommunicationRecommendation(props.data, values.value, props.row || undefined));
  communicationEdited = false;
  preview.value = null;
  error.value = "";
}
function choices(key: string) {
  const options = pointChoices(props.data, key, values.value);
  return key === "endpoint_key" && props.canWrite
    ? options.filter(endpoint => allowsScope(permissions.state.value, { board_key: props.boardKey, scope: "protocol", endpoint_key: endpoint.id }))
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
  if (recommendationFields(props.data).includes(key)) communicationEdited = true;
  if (key === props.data.definition.presentation?.suggestion?.source_key && !props.row && !communicationEdited)
    Object.assign(values.value, editableCommunicationRecommendation(props.data, values.value));
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
  if (key === "internal_type" && stringPoint.value) {
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
          fieldApplies(props.data, k, values.value) && (op === "create" || JSON.stringify(v) !== JSON.stringify(initial[k])),
      ),
    );
    if (op === "update" && !Object.keys(changed).length)
      throw new Error("请先修改需要调整的字段。");
    preview.value = await api(
      `/projects/${props.pid}/boards/${encodeURIComponent(props.boardKey)}/point-tables/${props.data.kind}/preview`,
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
  return pointChangeSummary(change, def.fields);
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
        <p v-else-if="permissions.state.value?.edit_scope === 'scoped'" class="notice">保存时会检查内部点与转发表的一致性，并校验本次修改的授权范围。</p>
        <div v-if="hasRecommendation(data)" class="notice point-communication-notice" role="status">
          <span>{{ recommendationHint }}</span>
          <button v-if="recommendation && canWrite" type="button" class="button small" :disabled="busy || !canSubmit || !recommendationDiffers" @click="applyRecommendation">应用通信建议</button>
        </div>
        <div class="form-grid">
          <Field
            v-for="key in editorFields"
            :key="key"
            :label="def.fields[key].label"
            :hint="recommendationFields(data).includes(key) ? recommendationHint : def.fields[key].hint"
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
                未指定
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
            <textarea
              v-else-if="def.fields[key].multiline"
              :aria-label="def.fields[key].label"
              :value="values[key] ?? ''"
              :disabled="!canWrite || busy"
              rows="4"
              @input="set(key, $event)"
            />
            <input
              v-else
              :type="def.fields[key].type === 'number' ? 'number' : 'text'"
              :step="def.fields[key].type === 'number' ? 'any' : undefined"
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
          <PointWarnings :warnings="preview.warnings" />
          <p v-if="preview.impact.affected_types?.length">
            涉及板卡类型：{{
              preview.impact.affected_types.map((t: Row) => t.code).join("、")
            }}
          </p>
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

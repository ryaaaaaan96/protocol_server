<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { api, revisionConflict, type Row } from "../api";
import { referenceOptions } from "../domain/board";
import { specs, labelFor, labels, type FieldSpec } from "../domain/schema";
import { isStringType } from "../domain/pointTables";
import Modal from "./Modal.vue";
import Field from "./Field.vue";
import { usePermissionContext } from "../composables/useProjectPermissions";
import { allowsEntity } from "../domain/permissions";
import { LoaderCircle, ArrowRight, GitBranch, Trash2 } from "@lucide/vue";
const props = defineProps<{
  pid: number;
  graph: Row;
  entity: string;
  row?: Row | null;
  canWrite: boolean;
  board?: Row;
  defaults?: Row;
  bindingRole?: string;
}>();
const emit = defineEmits<{ close: []; done: [record: Row, merged?: boolean]; error: [message: string]; conflict: [] }>();
const spec = computed(() => specs[props.entity]);
const values = ref<Row>({}),
  preview = ref<Row | null>(null),
  busy = ref(false),
  error = ref(""),
  operation = ref(props.row ? "update" : "create");
for (const f of spec.value.fields)
  values.value[f.key] =
    props.row?.[f.key] ??
    props.defaults?.[f.key] ??
    f.default ??
    (f.type === "boolean"
      ? false
      : f.nullable
        ? null
        : f.ref || f.type === "number"
          ? null
          : "");
const initial: Row = JSON.parse(JSON.stringify(values.value));
const permissions = usePermissionContext();
const scopeAllowed = computed(() => !props.row || allowsEntity(permissions.state.value, props.graph, props.entity, props.row));
const stringRange = computed(() => {
  if (props.entity === "data_items") return isStringType(values.value.data_type);
  if (props.entity !== "signal_ranges") return false;
  const signal = props.graph.signals.find((s: Row) => s.id === values.value.signal_id);
  const source = props.graph.data_items.find((d: Row) => d.id === signal?.data_item_id);
  return isStringType(signal?.internal_type ?? source?.data_type);
});
const editorFields = computed(() => spec.value.fields.filter(f => !stringRange.value || !["min_value", "max_value"].includes(f.key)));
watch(
  values,
  () => {
    preview.value = null;
    error.value = "";
    operation.value = props.row ? "update" : "create";
  },
  { deep: true },
);
function choices(f: FieldSpec) {
  return referenceOptions(
    props.graph,
    props.entity,
    f.key,
    f.ref!,
    values.value,
    props.board,
    props.bindingRole,
  );
}
function fixed(f: FieldSpec) {
  return f.key === "model_id" && !!props.board && props.entity !== "boards";
}
function set(f: FieldSpec, event: Event) {
  const el = event.target as HTMLInputElement;
  values.value[f.key] =
    f.type === "boolean"
      ? el.checked
      : el.value === "" && f.nullable
        ? null
        : f.type === "number" || f.ref
          ? el.value === ""
            ? null
            : Number(el.value)
          : el.value;
  // A changed endpoint/group/board must not keep references to its old scope.
  if (f.ref)
    for (let pass = 0; pass < 2; pass++)
      for (const field of spec.value.fields) {
        if (
          field.ref &&
          values.value[field.key] != null &&
          !choices(field).some((r) => r.id === values.value[field.key])
        )
          values.value[field.key] = null;
      }
  if (["data_type", "signal_id"].includes(f.key) && stringRange.value) {
    values.value.min_value = props.entity === "data_items" ? "" : null;
    values.value.max_value = props.entity === "data_items" ? "" : null;
  }
}
async function review(op = props.row ? "update" : "create") {
  if (!props.canWrite || busy.value) return;
  if (!allowsEntity(permissions.state.value, props.graph, props.entity, op === "delete" ? props.row : { ...props.row, ...values.value })) {
    error.value = "当前记录或修改后的目标不在你的编辑范围内；共享配置需要全部受影响板卡和协议的权限。";
    return;
  }
  busy.value = true;
  error.value = "";
  operation.value = op;
  try {
    if (
      props.entity === "board_links" &&
      props.board &&
      values.value.client_board_id !== props.board.id &&
      values.value.server_board_id !== props.board.id
    )
      throw new Error("连接至少有一端需要属于当前板卡。");
    preview.value = await api(
      `/projects/${props.pid}/changes/preview`,
      "POST",
      {
        revision: props.graph.revision,
        entity: props.entity,
        operation: op,
        id: props.row?.id ?? null,
        values: op === "update" ? Object.fromEntries(Object.entries(values.value).filter(([key,value]) => JSON.stringify(value) !== JSON.stringify(initial[key]))) : values.value,
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
  if (!props.canWrite || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api(
      `/projects/${props.pid}/changes/${preview.value!.id}/commit`,
      "POST",
      {},
    );
    emit("done", result.record, !!(result.merged || preview.value?.merged));
  } catch (e) {
    error.value = (e as Error).message;
    emit("error", error.value);
    if (revisionConflict(e)) emit("conflict");
    preview.value = null;
  } finally {
    busy.value = false;
  }
}
function delta(c: Row) {
  const a = c.after || {},
    b = c.before || {};
  return Object.keys({ ...b, ...a })
    .filter(
      (k) =>
        JSON.stringify(a[k]) !== JSON.stringify(b[k]) &&
        !["raw_json", "project_id"].includes(k),
    )
    .map((k) => `${labels[k] || k}: ${b[k] ?? "—"} → ${a[k] ?? "—"}`)
    .join("；");
}
const related = computed(() =>
  props.entity === "data_items" && props.row
    ? {
        signals: props.graph.signals.filter(
          (s: Row) => s.data_item_id === props.row!.id,
        ),
        fields: props.graph.protocol_fields.filter(
          (f: Row) => f.data_item_id === props.row!.id,
        ),
      }
    : null,
);
</script>
<template>
  <Modal
    lock-guard
    :title="`${row ? '编辑' : '新建'}${spec.label}`"
    wide
    @close="emit('close')"
  >
    <form @submit.prevent="review()">
      <div class="modal-body">
        <p v-if="!scopeAllowed" class="notice">此配置不在你的编辑范围内，可以查看。请联系管理员分配对应板卡或协议权限。</p>
        <div v-if="board" class="editor-scope">
          <strong>{{ board.name }}</strong
          ><span
            >{{ board.code }} ·
            {{
              graph.board_models.find((m: Row) => m.id === board?.model_id)
                ?.name
            }}</span
          ><small
            >按当前板卡选择关联项；共享配置的影响范围会在提交前列出。</small
          >
        </div>
        <div v-if="related" class="notice">
          <strong
            >共享定义 · {{ related.signals.length }} 个内部信号 /
            {{ related.fields.length }} 个协议字段引用</strong
          >
          <p>
            类型、长度和默认范围修改后会共同生效。提交前可以查看地址移动和所有受影响的引用。
          </p>
        </div>
        <div class="form-grid">
          <Field
            v-for="f in editorFields"
            :key="f.key"
            :label="f.label"
            :hint="f.hint"
          >
            <input
              v-if="f.type === 'boolean'"
              :aria-label="f.label"
              type="checkbox"
              :checked="!!values[f.key]"
              :disabled="!canWrite || busy"
              @change="set(f, $event)"
            />
            <select
              v-else-if="f.ref"
              :aria-label="f.label"
              :value="values[f.key] ?? ''"
              :disabled="!canWrite || busy || fixed(f)"
              :required="!f.nullable"
              @change="set(f, $event)"
            >
              <option value="">{{ f.nullable ? "未指定" : "请选择" }}</option>
              <option v-for="r in choices(f)" :key="r.id" :value="r.id">
                {{ labelFor(graph, f.ref, r.id) }}
              </option>
            </select>
            <select
              v-else-if="f.options"
              :aria-label="f.label"
              :value="values[f.key] ?? ''"
              :disabled="!canWrite || busy"
              @change="set(f, $event)"
            >
              <option v-if="f.nullable" value="">跟随共享定义</option>
              <option v-for="o in f.options" :key="o" :value="o">
                {{ o }}
              </option>
            </select>
            <input
              v-else
              :aria-label="f.label"
              :type="f.type === 'number' ? 'number' : 'text'"
              :step="f.key === 'scale' ? 'any' : '1'"
              :value="values[f.key] ?? ''"
              :disabled="!canWrite || busy"
              :required="
                ['name', 'code', 'enum_name', 'symbol'].includes(f.key)
              "
              @input="set(f, $event)"
            />
          </Field>
        </div>
        <div v-if="error" class="notice danger" role="alert">{{ error }}</div>
        <section v-if="preview" class="change-preview">
          <p v-if="preview.merged" class="notice">已合并其他成员的无关修改，请确认最新关联影响。</p>
          <h3>
            <GitBranch :size="18" />{{
              operation === "delete" ? "删除影响" : "关联变更预览"
            }}
            · {{ preview.impact.count }} 项变化
          </h3>
          <div
            :class="['notice', preview.allowed ? '' : 'danger']"
            role="status"
          >
            {{
              preview.allowed
                ? "关联检查通过，可以提交。"
                : "此次修改会造成以下问题，已阻止提交。"
            }}
            <p v-for="(e, i) in preview.errors" :key="i">{{ e.message }}</p>
          </div>
          <p v-if="preview.impact.affected_types?.length">
            涉及板卡类型：{{
              preview.impact.affected_types
                .map((t: Row) => `${t.code}（${t.quantity} 个挂载）`)
                .join("、")
            }}
          </p>
          <p v-else-if="preview.impact.affected_boards?.length">
            涉及板卡：{{
              preview.impact.affected_boards.map((b: Row) => b.name).join("、")
            }}
          </p>
          <div class="impact-list">
            <article v-for="(c, i) in preview.impact.changes" :key="i">
              <strong>{{
                c.after?.name || c.before?.name || c.after?.signal_name || c.key
              }}</strong
              ><small>{{ c.entity }}</small>
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
          <Trash2 :size="15" />预览删除
        </button>
        <button type="button" class="button" @click="emit('close')">
          关闭
        </button>
        <template v-if="canWrite"
          ><button class="button" :disabled="busy">
            <LoaderCircle
              v-if="busy"
              class="spin"
              :size="16"
            />检查关联影响</button
          ><button
            v-if="preview?.allowed"
            type="button"
            class="button primary"
            :disabled="busy"
            @click="commit"
          >
            确认{{ operation === "delete" ? "删除" : "提交"
            }}<ArrowRight :size="16" /></button
        ></template>
      </div>
    </form>
  </Modal>
</template>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { api, type Row } from "../api";
import { specs, labelFor, labels, type FieldSpec } from "../domain/schema";
import Modal from "./Modal.vue";
import Field from "./Field.vue";
import { LoaderCircle, ArrowRight, GitBranch, Trash2 } from "@lucide/vue";
const props = defineProps<{
  pid: number;
  graph: Row;
  entity: string;
  row?: Row | null;
  canWrite: boolean;
}>();
const emit = defineEmits<{ close: []; done: [] }>();
const spec = computed(() => specs[props.entity]);
const values = ref<Row>({}),
  preview = ref<Row | null>(null),
  busy = ref(false),
  error = ref(""),
  operation = ref(props.row ? "update" : "create");
for (const f of spec.value.fields)
  values.value[f.key] =
    props.row?.[f.key] ??
    f.default ??
    (f.type === "boolean"
      ? false
      : f.nullable
        ? null
        : f.ref || f.type === "number"
          ? null
          : "");
watch(
  values,
  () => {
    preview.value = null;
    error.value = "";
    operation.value = props.row ? "update" : "create";
  },
  { deep: true },
);
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
}
async function review(op = props.row ? "update" : "create") {
  busy.value = true;
  error.value = "";
  operation.value = op;
  try {
    preview.value = await api(
      `/projects/${props.pid}/changes/preview`,
      "POST",
      {
        revision: props.graph.revision,
        entity: props.entity,
        operation: op,
        id: props.row?.id ?? null,
        values: values.value,
      },
    );
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function commit() {
  busy.value = true;
  error.value = "";
  try {
    await api(
      `/projects/${props.pid}/changes/${preview.value!.id}/commit`,
      "POST",
      {},
    );
    emit("done");
  } catch (e) {
    error.value = (e as Error).message;
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
    :title="`${row ? '编辑' : '新建'}${spec.label}`"
    wide
    @close="emit('close')"
  >
    <form @submit.prevent="review()">
      <div class="modal-body">
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
            v-for="f in spec.fields"
            :key="f.key"
            :label="f.label"
            :hint="f.hint"
          >
            <input
              v-if="f.type === 'boolean'"
              type="checkbox"
              :checked="!!values[f.key]"
              :disabled="!canWrite || busy"
              @change="set(f, $event)"
            />
            <select
              v-else-if="f.ref"
              :value="values[f.key] ?? ''"
              :disabled="!canWrite || busy"
              :required="!f.nullable"
              @change="set(f, $event)"
            >
              <option value="">{{ f.nullable ? "未指定" : "请选择" }}</option>
              <option v-for="r in graph[f.ref]" :key="r.id" :value="r.id">
                {{ labelFor(graph, f.ref, r.id) }}
              </option>
            </select>
            <select
              v-else-if="f.options"
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
          <p v-if="preview.impact.affected_boards?.length">
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

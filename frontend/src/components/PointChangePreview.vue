<script setup lang="ts">
import { ref } from "vue";
import { api, revisionConflict, type Row } from "../api";
import { pointChangeSummary, type PointField } from "../domain/pointTables";
import Modal from "./Modal.vue";
import PointWarnings from "./PointWarnings.vue";
const props = defineProps<{pid:number; preview:Row; title:string; canWrite:boolean; checkOnly?:boolean; fields?:Record<string,PointField>; fieldsByEntity?:Record<string,Record<string,PointField>>}>();
const emit = defineEmits<{close:[]; done:[merged:boolean]; error:[message:string]; conflict:[]}>();
const busy = ref(false), error = ref("");
async function commit() {
  if (props.checkOnly || !props.canWrite || !props.preview.allowed || busy.value) return;
  busy.value = true;
  try {
    const result = await api(`/projects/${props.pid}/changes/${props.preview.id}/commit`, "POST", {});
    emit("done", !!(result.merged || props.preview.merged));
  } catch(e) {
    error.value = (e as Error).message;
    emit("error", error.value);
    if (revisionConflict(e)) emit("conflict");
  }
  finally { busy.value = false; }
}
function changes(change:Row) {
  return pointChangeSummary(change, props.fieldsByEntity?.[change.entity?.replace(/^points\./, "")] || props.fields);
}
</script>
<template>
  <Modal :title="title" wide lock-guard @close="!busy && emit('close')">
    <div class="modal-body">
      <p v-if="!canWrite" class="notice">当前为只读，尚未提交的修改已保留。请返回并重新取得编辑权后检查提交。</p>
      <div :class="['notice', {danger:!preview.allowed}]" role="status">
        {{ preview.allowed ? (checkOnly ? '本次修改的关联检查通过，尚未保存。' : '关联检查通过，确认后保存。') : (checkOnly ? '检查发现问题，请调整后重新检查。' : '此修改不能提交，请调整后重新检查。') }}
        <p v-for="(problem,i) in preview.errors" :key="i"><template v-if="problem.row">原始点表第 {{ problem.row }} 行 · </template><template v-if="problem.field">{{ fields?.[problem.field]?.label || problem.field }}： </template>{{ problem.message }}</p>
      </div>
      <PointWarnings :warnings="preview.warnings" />
      <p v-if="checkOnly" class="muted">本次仅检查，草稿继续保留；检查不会释放编辑权。</p>
      <template v-if="checkOnly && preview.validation">
        <p>按当前草稿校验整个项目：{{ preview.validation.errors }} 条错误、{{ preview.validation.warnings }} 条提示（包含项目原有问题）。关联检查通过表示本次修改没有新增阻断问题。</p>
        <details v-if="preview.validation.issues?.length">
          <summary>查看项目校验问题</summary>
          <div class="impact-list">
            <article v-for="(issue,i) in preview.validation.issues.slice(0, 200)" :key="i">
              <strong>{{ issue.level === 'error' ? '错误' : '提示' }} · {{ issue.name }}</strong>
              <p>{{ issue.message }}</p>
              <small v-if="issue.source_sheet">{{ issue.source_sheet }} · 第 {{ issue.source_row }} 行</small>
            </article>
          </div>
          <p v-if="preview.validation.issues.length > 200" class="muted">显示前 200 条问题；全部数据已检查。</p>
        </details>
      </template>
      <p v-if="preview.merged" class="notice">已合并其他成员的无关修改，请确认最新关联影响。</p>
      <p v-if="preview.impact.affected_types?.length">涉及板卡：{{ preview.impact.affected_types.map((t:Row) => t.name || t.code).join('、') }}</p>
      <p>关联变更 {{ preview.impact.count }} 项</p>
      <div class="impact-list">
        <article v-for="(change,i) in preview.impact.changes" :key="i"><strong>{{ change.after?.name || change.after?.signal_name || change.key }}</strong><p>{{ changes(change) }}</p></article>
      </div>
      <p v-if="preview.impact.count > 200" class="muted">显示前 200 项；全部关联已检查。</p>
      <div v-if="error" class="notice danger" role="alert">{{ error }}。请返回并重新载入数据后检查。</div>
    </div>
    <div class="modal-footer">
      <button :class="['button', {primary:checkOnly}]" :disabled="busy" @click="emit('close')">{{ checkOnly ? '继续编辑' : '返回调整' }}</button>
      <button v-if="!checkOnly && preview.allowed && !error" class="button primary" :disabled="busy || !canWrite" @click="commit">确认提交</button>
    </div>
  </Modal>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { History, ChevronRight } from "@lucide/vue";
import { api, time, actions, type Row } from "../api";
import Empty from "../components/Empty.vue";
import Loading from "../components/Loading.vue";
import Modal from "../components/Modal.vue";
const props = defineProps<{ pid: number; tick: number }>();
const emit = defineEmits<{ error: [message: string] }>();
const rows = ref<Row[] | null>(null),
  selected = ref<Row | null>(null);
watch(
  () => [props.pid, props.tick],
  () =>
    api(`/projects/${props.pid}/audit`)
      .then((v) => (rows.value = v))
      .catch((e) => emit("error", e.message)),
  { immediate: true },
);
</script>
<template>
  <section class="panel table-panel">
    <div class="panel-heading">
      <h3>项目变更记录</h3>
      <span class="muted">最近 200 条 · 仅追加记录</span>
    </div>
    <Loading v-if="!rows" />
    <div v-else-if="rows.length" class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>操作</th>
            <th>操作人</th>
            <th>对象</th>
            <th>时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td>
              <div class="inline">
                <History :size="15" class="muted" /><strong>{{
                  actions[r.action] || r.action
                }}</strong>
              </div>
            </td>
            <td>{{ r.display_name }}</td>
            <td class="mono muted">{{ r.entity }}</td>
            <td class="muted">{{ time(r.created_at) }}</td>
            <td>
              <button class="text-button" @click="selected = r">
                查看变更<ChevronRight :size="14" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <Empty v-else title="暂无操作记录" />
  </section>
  <Modal
    v-if="selected"
    :title="`${actions[selected.action] || selected.action} · ${time(selected.created_at)}`"
    wide
    @close="selected = null"
    ><div class="modal-body">
      <div class="diff-grid">
        <div>
          <h4>修改前</h4>
          <pre>{{ JSON.stringify(selected.before_data, null, 2) }}</pre>
        </div>
        <div>
          <h4>修改后</h4>
          <pre>{{ JSON.stringify(selected.after_data, null, 2) }}</pre>
        </div>
      </div>
    </div></Modal
  >
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { api, time, type Row } from "../api";
import Badge from "../components/Badge.vue";
import Modal from "../components/Modal.vue";
import Field from "../components/Field.vue";
const props = defineProps<{ tick: number; user: Row }>();
const emit = defineEmits<{
  notify: [message: string, error?: boolean];
  refresh: [];
}>();
const users = ref<Row[]>([]),
  edit = ref<Row | null>(null),
  error = ref(""),
  busy = ref(false);
watch(edit, () => (error.value = ""));
watch(
  () => props.tick,
  () =>
    api("/users")
      .then((v) => (users.value = v))
      .catch((e) => emit("notify", e.message, true)),
  { immediate: true },
);
async function save() {
  busy.value = true;
  error.value = "";
  try {
    await api(`/users/${edit.value!.id}`, "PUT", edit.value);
    edit.value = null;
    emit("refresh");
    emit("notify", "账号已更新，原登录会话已失效");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="panel table-panel">
    <div class="panel-heading">
      <h3>平台账号</h3>
      <Badge>{{ users.length }} 个账号</Badge>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>账号名称</th>
            <th>用户名</th>
            <th>平台角色</th>
            <th>账号状态</th>
            <th>创建时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>
              <div class="inline">
                <div class="avatar pale">{{ u.display_name.slice(0, 1) }}</div>
                <strong>{{ u.display_name }}</strong
                ><Badge v-if="u.id === user.id">我</Badge>
              </div>
            </td>
            <td class="mono">{{ u.username }}</td>
            <td>{{ u.is_admin ? "平台管理员" : "项目成员" }}</td>
            <td>
              <Badge :tone="u.active ? 'teal' : 'gray'">{{
                u.active ? "启用" : "已禁用"
              }}</Badge>
            </td>
            <td class="muted">{{ time(u.created_at) }}</td>
            <td>
              <button
                class="text-button"
                @click="edit = { ...u, password: '' }"
              >
                管理
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <Modal
    v-if="edit"
    :title="`管理账号 · ${edit.display_name}`"
    @close="edit = null"
    ><form @submit.prevent="save">
      <div class="modal-body">
        <Field label="账号状态"
          ><select v-model="edit.active" :disabled="edit.id === user.id">
            <option :value="true">启用</option>
            <option :value="false">禁用</option>
          </select></Field
        ><Field label="平台角色"
          ><select v-model="edit.is_admin" :disabled="edit.id === user.id">
            <option :value="false">项目成员</option>
            <option :value="true">平台管理员</option>
          </select></Field
        ><Field label="重置密码" hint="留空不修改；新密码至少 12 个字符。"
          ><input
            type="password"
            autocomplete="new-password"
            minlength="12"
            v-model="edit.password"
        /></Field>
        <div class="notice">保存会使此账号的已有登录会话失效。</div>
        <div v-if="error" class="notice danger" role="alert">{{ error }}</div>
      </div>
      <div class="modal-footer">
        <button type="button" class="button" @click="edit = null">取消</button
        ><button class="button primary" :disabled="busy">保存账号</button>
      </div>
    </form></Modal
  >
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { api } from "../api";
import Modal from "./Modal.vue";
import Field from "./Field.vue";
const emit = defineEmits<{ close: []; done: [] }>();
const user = reactive({
    username: "",
    display_name: "",
    password: "",
    is_admin: false,
  }),
  error = ref(""),
  busy = ref(false);
async function save() {
  busy.value = true;
  try {
    await api("/users", "POST", user);
    emit("done");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal title="创建账号" @close="emit('close')"
    ><form @submit.prevent="save">
      <div class="modal-body">
        <Field
          label="用户名"
          hint="使用字母、数字和下划线，以字母或下划线开头。"
          ><input
            v-model="user.username"
            autocomplete="off"
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            required
            maxlength="80" /></Field
        ><Field label="显示名称"
          ><input v-model="user.display_name" required maxlength="100" /></Field
        ><Field label="初始密码" hint="至少 12 个字符。"
          ><input
            v-model="user.password"
            type="password"
            minlength="12"
            maxlength="256"
            autocomplete="new-password"
            required /></Field
        ><label class="confirm-checkbox"
          ><input
            type="checkbox"
            v-model="user.is_admin"
          />授予平台管理员权限</label
        >
        <div v-if="error" class="notice danger">{{ error }}</div>
      </div>
      <div class="modal-footer">
        <button type="button" class="button" @click="emit('close')">取消</button
        ><button class="button primary" :disabled="busy">创建账号</button>
      </div>
    </form></Modal
  >
</template>

<script setup lang="ts">
import { ref } from "vue";
import {
  Network,
  ArrowRight,
  Database,
  Braces,
  FileCode2,
  LockKeyhole,
  LoaderCircle,
} from "@lucide/vue";
import { api, type Row } from "../api";
import Field from "../components/Field.vue";
const emit = defineEmits<{ login: [user: Row] }>();
const username = ref(""),
  password = ref(""),
  busy = ref(false),
  error = ref("");
async function login() {
  busy.value = true;
  error.value = "";
  try {
    emit(
      "login",
      await api("/auth/login", "POST", {
        username: username.value,
        password: password.value,
      }),
    );
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="login-screen">
    <div class="login-story">
      <div class="brand">
        <div class="brand-mark"><Network :size="25" /></div>
        <div>Protocol<span>STUDIO</span></div>
      </div>
      <div class="login-copy">
        <span class="eyebrow">ENGINEERED FOR CLARITY</span>
        <h1>从一张点表，<br />到统一的协议工作空间。</h1>
        <p>
          用清晰的数据关系连接测点、设备与协议。<br />让每一次修改有迹可循，每一份配置值得信赖。
        </p>
        <div class="login-flow">
          <span><Database />数据建模</span><ArrowRight /><span
            ><Braces />SQL 派生</span
          ><ArrowRight /><span><FileCode2 />配置生成</span>
        </div>
      </div>
      <small>POSTGRESQL · RUST · VUE 3</small>
    </div>
    <div class="login-panel">
      <form @submit.prevent="login">
        <div class="login-emblem"><LockKeyhole :size="24" /></div>
        <h2>登录工作空间</h2>
        <p>使用管理员分配的账号继续</p>
        <Field label="用户名"
          ><input
            v-model="username"
            autocomplete="username"
            required
            autofocus
            placeholder="请输入用户名"
        /></Field>
        <Field label="密码"
          ><input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            placeholder="请输入密码"
        /></Field>
        <div v-if="error" class="notice danger" role="alert">{{ error }}</div>
        <button class="button primary full" :disabled="busy">
          <LoaderCircle v-if="busy" class="spin" :size="18" />登录<ArrowRight
            :size="17"
          />
        </button>
        <p class="login-help">首次登录信息请查看部署配置或联系管理员。</p>
      </form>
    </div>
  </div>
</template>

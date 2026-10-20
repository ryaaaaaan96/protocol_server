<script setup lang="ts">
import type { Row } from "../api";
defineProps<{ warnings?: (Row | string)[] }>();
</script>
<template>
  <div v-if="warnings?.length" class="notice point-communication-warnings" role="status">
    <strong>提交前请确认以下提示</strong>
    <p v-for="(warning, index) in warnings" :key="index">
      <template v-if="typeof warning === 'string'">{{ warning }}</template>
      <template v-else><span v-if="warning.row">第 {{ warning.row }} 行 · </span><span v-if="warning.name">{{ warning.name }}： </span>{{ warning.message }}</template>
    </p>
    <small>提示不会阻止提交；请核对后确认本次修改。</small>
  </div>
</template>

<script setup lang="ts">
import { LoaderCircle } from "@lucide/vue";
</script>
<template>
  <div class="loading">
    <LoaderCircle class="spin" :size="22" />正在读取数据…
  </div>
</template>

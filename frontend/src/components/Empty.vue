<script setup lang="ts">
import { Database } from "@lucide/vue";
defineProps<{ title: string; detail?: string }>();
</script>
<template>
  <div class="empty">
    <Database :size="32" />
    <h3>{{ title }}</h3>
    <p v-if="detail">{{ detail }}</p>
    <slot />
  </div>
</template>

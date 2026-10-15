<script setup lang="ts">
import { ref, computed } from "vue";
import {
  AlertTriangle,
  ShieldCheck,
  RefreshCw,
  Search,
  ChevronRight,
} from "@lucide/vue";
import type { Row } from "../api";
import Badge from "../components/Badge.vue";
import Empty from "../components/Empty.vue";
import Loading from "../components/Loading.vue";
const props = defineProps<{ report?: Row }>();
defineEmits<{ edit: [issue: Row]; refresh: [] }>();
const level = ref("error"),
  query = ref("");
const rows = computed(
  () =>
    props.report?.issues.filter(
      (v: Row) =>
        (!level.value || v.level === level.value) &&
        `${v.name}${v.message}`.includes(query.value),
    ) || [],
);
</script>
<template>
  <Loading v-if="!report" /><template v-else
    ><div class="validation-summary">
      <div :class="['validation-symbol', { warning: report.errors }]">
        <AlertTriangle v-if="report.errors" :size="28" /><ShieldCheck
          v-else
          :size="28"
        />
      </div>
      <div>
        <h3>
          {{
            report.errors
              ? "修复错误后即可生成工程配置"
              : "当前数据通过阻断性检查"
          }}
        </h3>
        <p>检查 ID 映射、C 枚举、UPP 区间、Modbus 地址、类型长度与取值范围。</p>
      </div>
      <button class="button" @click="$emit('refresh')">
        <RefreshCw :size="16" />重新校验
      </button>
    </div>
    <section class="panel table-panel">
      <div class="table-toolbar">
        <div class="tabs">
          <button
            v-for="[k, v] in [
              ['error', `错误 ${report.errors}`],
              ['warning', `提示 ${report.warnings}`],
              ['', '全部'],
            ]"
            :key="k"
            :class="{ selected: level === k }"
            @click="level = k"
          >
            {{ v }}
          </button>
        </div>
        <div class="search">
          <Search :size="16" /><input
            aria-label="搜索校验问题"
            placeholder="搜索测点或问题…"
            v-model="query"
          />
        </div>
      </div>
      <div v-if="rows.length" class="issue-list">
        <button
          class="issue"
          v-for="(r, i) in rows.slice(0, 300)"
          :key="i"
          @click="$emit('edit', r)"
        >
          <span :class="['issue-icon', r.level]"
            ><AlertTriangle :size="18"
          /></span>
          <div>
            <div>
              <strong>{{ r.name }}</strong
              ><Badge
                :tone="r.entity === 'protocol_fields' ? 'blue' : 'teal'"
                >{{ r.entity }}</Badge
              ><code>{{ r.code }}</code>
            </div>
            <p>{{ r.message }}</p>
            <small>{{
              r.source_sheet
                ? `${r.source_sheet} · 第 ${r.source_row} 行`
                : `${r.entity} #${r.id}`
            }}</small>
          </div>
          <ChevronRight :size="18" />
        </button>
        <p v-if="rows.length > 300" class="muted padded">
          展示前 300 条，可搜索定位其余问题。
        </p>
      </div>
      <Empty
        v-else
        title="没有匹配的问题"
        detail="此筛选下未发现需要处理的数据。"
      /></section
  ></template>
</template>

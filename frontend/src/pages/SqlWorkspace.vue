<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  Database,
  Layers3,
  Table2,
  Code2,
  Braces,
  Play,
  LoaderCircle,
  LockKeyhole,
} from "@lucide/vue";
import { api, type Row } from "../api";
import Badge from "../components/Badge.vue";
import Empty from "../components/Empty.vue";
import Modal from "../components/Modal.vue";
const props = defineProps<{ pid: number }>();
const emit = defineEmits<{ error: [message: string] }>();
const definitions = ref<Row | null>(null),
  sql = ref(
    "SELECT client_board, server_board, protocol, transport, remote_address\nFROM v_topology_links\nORDER BY id",
  ),
  result = ref<Row | null>(null),
  busy = ref(false),
  error = ref(""),
  showRules = ref(false);
const columns = computed(() =>
  result.value?.rows.length ? Object.keys(result.value.rows[0]) : [],
);
onMounted(() =>
  api("/sql/definitions")
    .then((v) => (definitions.value = v))
    .catch((e) => emit("error", e.message)),
);
async function execute() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    result.value = await api(`/projects/${props.pid}/sql`, "POST", {
      sql: sql.value,
    });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function keydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    execute();
  }
}
function cell(v: unknown) {
  return v === null
    ? "NULL"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);
}
</script>
<template>
  <div class="sql-layout">
    <aside class="panel sql-explorer">
      <div class="panel-heading">
        <h3><Database :size="17" />项目数据</h3>
      </div>
      <div class="sql-explorer-section">
        <small>业务表与派生视图</small
        ><button
          v-for="r in definitions?.relations"
          :key="r"
          @click="sql = `SELECT * FROM ${r}\nLIMIT 100`"
        >
          <Layers3 v-if="r.startsWith('v_')" :size="15" /><Table2
            v-else
            :size="15"
          /><code>{{ r }}</code>
        </button>
      </div>
      <div class="sql-explorer-section">
        <small>查询示例</small
        ><button
          v-for="e in definitions?.examples"
          :key="e.name"
          @click="sql = e.sql"
        >
          <Code2 :size="15" />{{ e.name }}
        </button>
      </div>
      <button class="button small sql-rules" @click="showRules = true">
        <Braces :size="15" />查看 SQL 规则源码
      </button>
    </aside>
    <section class="panel sql-editor">
      <div class="code-heading">
        <div>
          <span class="status-dot" /><span>query.sql</span
          ><Badge>PostgreSQL</Badge>
        </div>
        <button class="button primary small" :disabled="busy" @click="execute">
          <LoaderCircle v-if="busy" class="spin" :size="15" /><Play
            v-else
            :size="15"
          />运行查询
        </button>
      </div>
      <div class="editor-wrap">
        <div class="line-numbers">
          <span v-for="(_, i) in sql.split('\n')" :key="i">{{ i + 1 }}</span>
        </div>
        <textarea
          spellcheck="false"
          aria-label="SQL 查询编辑器"
          v-model="sql"
          @keydown="keydown"
        />
      </div>
      <div class="sql-status">
        <span><LockKeyhole :size="13" />当前项目 · 只读查询</span
        ><span>最多 500 行 · 3 秒超时 · Ctrl + Enter 运行</span>
      </div>
    </section>
  </div>
  <section class="panel table-panel section-gap">
    <div class="panel-heading">
      <h3>查询结果</h3>
      <span v-if="result" class="muted"
        >{{ result.rows.length }} 行 · {{ result.elapsed_ms }} ms{{
          result.truncated ? " · 结果已截断" : ""
        }}</span
      >
    </div>
    <div v-if="error" class="notice danger sql-error" role="alert">
      {{ error }}
    </div>
    <Empty
      v-else-if="!result"
      title="数据关系，从一次查询开始"
      detail="选择左侧示例，或编写 SQL 后点击运行。"
    /><Empty v-else-if="!result.rows.length" title="查询成功，没有返回数据" />
    <div v-else class="table-scroll sql-results">
      <table>
        <thead>
          <tr>
            <th v-for="c in columns" :key="c">{{ c }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in result.rows" :key="i">
            <td
              v-for="c in columns"
              :key="c"
              :class="['mono', { muted: r[c] === null }]"
            >
              {{ cell(r[c]) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <Modal
    v-if="showRules"
    title="受版本控制的 SQL 派生规则"
    wide
    @close="showRules = false"
    ><div class="modal-body">
      <p class="muted">规则通过数据库迁移更新；工作台用于查询与核对。</p>
      <pre class="code-preview">{{ definitions?.sql }}</pre>
    </div></Modal
  >
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import {
  Network,
  Layers3,
  ChevronsUpDown,
  LayoutDashboard,
  Table2,
  Terminal,
  ShieldCheck,
  FileCode2,
  Users,
  History,
  Shield,
  LogOut,
  Menu,
  ChevronRight,
  RefreshCw,
  FolderPlus,
  Upload,
  Plus,
  AlertTriangle,
  CheckCircle2,
  X,
  LoaderCircle,
} from "@lucide/vue";
import { api, roles, type Row } from "./api";
import Badge from "./components/Badge.vue";
import Empty from "./components/Empty.vue";
import Loading from "./components/Loading.vue";
import Login from "./pages/Login.vue";
import TopologyWorkspace from "./pages/TopologyWorkspace.vue";
import SqlWorkspace from "./pages/SqlWorkspace.vue";
import Validation from "./pages/Validation.vue";
import Releases from "./pages/Releases.vue";
import Members from "./pages/Members.vue";
import Audit from "./pages/Audit.vue";
import UsersPanel from "./pages/UsersPanel.vue";
import ImportModal from "./components/ImportModal.vue";
import CreateProject from "./components/CreateProject.vue";
import CreateUser from "./components/CreateUser.vue";
const nav = [
  { id: "overview", label: "板卡拓扑", icon: LayoutDashboard },
  { id: "points", label: "数据与协议", icon: Table2 },
  { id: "devices", label: "模板与端点", icon: Network },
  { id: "sql", label: "SQL 工作台", icon: Terminal },
  { id: "validation", label: "数据校验", icon: ShieldCheck },
  { id: "releases", label: "代码与版本", icon: FileCode2 },
  { id: "members", label: "成员与权限", icon: Users },
  { id: "audit", label: "操作记录", icon: History },
];
const descriptions: Record<string, string> = {
  overview: "管理项目中的板卡实例、协议连接和数据流向。",
  points: "源定义、内部信号与协议映射分别维护，修改前检查关联影响。",
  devices: "维护可复用的板卡模板、设备上下文和通信端点。",
  sql: "用 SQL 查看数据关系，替代复杂的表格公式。",
  validation: "在配置进入工程之前，发现并定位数据问题。",
  releases: "从同一份数据生成配置，冻结每次交付的版本。",
  members: "按项目分配成员，让每个人拥有合适的权限。",
  audit: "记录数据与权限变化，追溯每一次操作。",
  users: "统一维护账号、登录权限与平台管理员。",
};
const user = ref<Row | null>(null),
  checking = ref(true),
  projects = ref<Row[]>([]),
  pid = ref(Number(localStorage.getItem("protocol-project")) || 0),
  tab = ref("overview"),
  overview = ref<Row | null>(null),
  overviewError = ref(""),
  tick = ref(0),
  toast = ref<{ message: string; error: boolean } | null>(null),
  modal = ref<string | null>(null),
  focus = ref<Row | null>(null),
  menu = ref(false);
const project = computed(() => projects.value.find((p) => p.id === pid.value)),
  canWrite = computed(() => !!project.value && project.value.role !== "viewer"),
  report = computed(() => overview.value?.validation),
  pageTitle = computed(
    () => nav.find((n) => n.id === tab.value)?.label || "账号管理",
  );
let toastTimer: ReturnType<typeof setTimeout>;
function notify(message: string, error = false) {
  toast.value = { message, error };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 6000);
}
function fail(message: string) {
  notify(message, true);
}
function refresh() {
  tick.value++;
}
function navigate(page: string) {
  tab.value = page;
  menu.value = false;
}
function expired() {
  user.value = null;
  focus.value = null;
  modal.value = null;
}
onMounted(async () => {
  window.addEventListener("session-expired", expired);
  try {
    user.value = await api("/auth/me");
  } catch {
  } finally {
    checking.value = false;
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("session-expired", expired);
  clearTimeout(toastTimer);
});
watch([user, tick], ([currentUser], _, onCleanup) => {
  let cancelled = false;
  onCleanup(() => (cancelled = true));
  if (!currentUser) {
    projects.value = [];
    return;
  }
  api("/projects")
    .then((rows) => {
      if (cancelled) return;
      projects.value = rows;
      if (!rows.some((p: Row) => p.id === pid.value))
        pid.value = rows[0]?.id || 0;
    })
    .catch((e) => {
      if (!cancelled) fail(e.message);
    });
});
watch([pid, tick, user], ([id, _, currentUser], __, onCleanup) => {
  let cancelled = false;
  onCleanup(() => (cancelled = true));
  localStorage.setItem("protocol-project", String(id));
  overview.value = null;
  overviewError.value = "";
  if (!id || !currentUser) return;
  api(`/projects/${id}/overview`)
    .then((data) => {
      if (!cancelled) overview.value = data;
    })
    .catch((e) => {
      if (!cancelled) {
        overviewError.value = e.message;
        fail(e.message);
      }
    });
});
function openIssue(issue: Row) {
  focus.value = { entity: issue.entity, id: issue.id };
  tab.value = "points";
  tick.value++;
}
function topologyDone() {
  focus.value = null;
  refresh();
  notify("修改已提交，关联配置已同步更新");
}
async function logout() {
  try {
    await api("/auth/logout", "POST", {});
    expired();
  } catch (e) {
    fail((e as Error).message);
  }
}
function importDone() {
  modal.value = null;
  refresh();
  navigate("validation");
  notify("点表已导入，查看校验结果以继续完善配置");
}
function projectCreated(p: Row) {
  modal.value = null;
  pid.value = p.id;
  navigate("overview");
  refresh();
  notify("项目已创建");
}
function userCreated() {
  modal.value = null;
  refresh();
  notify("账号已创建，请在项目成员中分配权限");
}
</script>
<template>
  <div v-if="checking" class="loading-screen">
    <LoaderCircle class="spin" />正在连接工作空间…
  </div>
  <Login v-else-if="!user" @login="user = $event" />
  <div v-else class="app-shell">
    <aside :class="['sidebar', { visible: menu }]">
      <div class="brand">
        <div class="brand-mark"><Network :size="24" /></div>
        <div>Protocol<span>STUDIO</span></div>
      </div>
      <div class="workspace-switch">
        <div class="workspace-icon"><Layers3 :size="19" /></div>
        <div>
          <small>当前工作空间</small
          ><select
            aria-label="当前项目"
            v-model.number="pid"
            @change="navigate('overview')"
          >
            <option v-if="!projects.length" :value="0">尚未加入项目</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">
              {{ p.name }}
            </option>
          </select>
        </div>
        <ChevronsUpDown :size="15" />
      </div>
      <div class="nav-caption">工作空间</div>
      <nav>
        <template v-for="(item, index) in nav" :key="item.id"
          ><div v-if="index === 6" class="nav-caption separated">协作管理</div>
          <button
            :class="['nav-item', { active: tab === item.id }]"
            @click="navigate(item.id)"
          >
            <component :is="item.icon" :size="18" /><span>{{ item.label }}</span
            ><span
              v-if="item.id === 'validation' && report?.errors > 0"
              class="nav-count"
              >{{ report.errors }}</span
            >
          </button></template
        ><button
          v-if="user.is_admin"
          :class="['nav-item', { active: tab === 'users' }]"
          @click="navigate('users')"
        >
          <Shield :size="18" /><span>账号管理</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="db-status">
          <span class="status-dot" /><span>PostgreSQL</span
          ><small>数据工作空间</small>
        </div>
        <div class="user-card">
          <div class="avatar">{{ user.display_name.slice(0, 1) }}</div>
          <div>
            <strong>{{ user.display_name }}</strong
            ><small>{{
              user.is_admin
                ? "平台管理员"
                : roles[project?.role] || "未分配项目"
            }}</small>
          </div>
          <button class="icon-btn" aria-label="退出登录" @click="logout">
            <LogOut :size="16" />
          </button>
        </div>
      </div>
    </aside>
    <div class="main-wrap">
      <header class="topbar">
        <button
          class="mobile-menu icon-btn"
          aria-label="导航菜单"
          @click="menu = !menu"
        >
          <Menu />
        </button>
        <div class="breadcrumbs">
          <span>工作空间</span><ChevronRight :size="14" /><strong>{{
            project?.name || "协议管理平台"
          }}</strong
          ><span class="crumb-sep">/</span><span>{{ pageTitle }}</span>
        </div>
        <div class="topbar-right">
          <span class="top-label"><span class="status-dot" />版本受控</span
          ><Badge v-if="project"
            >REV {{ overview?.project?.revision || project.revision }}</Badge
          ><button class="icon-btn" aria-label="刷新数据" @click="refresh">
            <RefreshCw :size="17" />
          </button>
        </div>
      </header>
      <main>
        <div class="page-heading">
          <div>
            <div class="eyebrow">PROTOCOL WORKSPACE</div>
            <h1>{{ pageTitle }}</h1>
            <p>{{ descriptions[tab] }}</p>
          </div>
          <div class="heading-actions">
            <button
              v-if="tab === 'overview' && user.is_admin"
              class="button"
              @click="modal = 'project'"
            >
              <FolderPlus :size="16" />新建项目</button
            ><button
              v-if="['points', 'overview'].includes(tab) && canWrite"
              class="button"
              @click="modal = 'import'"
            >
              <Upload :size="16" />导入 Excel</button
            ><button
              v-if="tab === 'users'"
              class="button primary"
              @click="modal = 'user'"
            >
              <Plus :size="17" />创建账号
            </button>
          </div>
        </div>
        <Empty
          v-if="!project && tab !== 'users'"
          title="从一个项目开始"
          :detail="
            user.is_admin
              ? '创建项目后，即可导入点表并分配成员。'
              : '请联系管理员，将你的账号加入项目。'
          "
          ><button
            v-if="user.is_admin"
            class="button primary"
            @click="modal = 'project'"
          >
            创建第一个项目
          </button></Empty
        >
        <template v-else>
          <TopologyWorkspace
            v-if="['overview', 'points', 'devices'].includes(tab)"
            :key="`${pid}:${tab}`"
            :pid="pid"
            :tick="tick"
            :can-write="canWrite"
            :mode="
              tab === 'overview'
                ? 'topology'
                : tab === 'points'
                  ? 'data'
                  : 'config'
            "
            :focus="tab === 'points' ? focus : null"
            @done="topologyDone"
            @error="fail"
          />
          <SqlWorkspace
            v-else-if="tab === 'sql'"
            :key="pid"
            :pid="pid"
            @error="fail"
          />
          <Validation
            v-else-if="tab === 'validation'"
            :report="report"
            @edit="openIssue"
            @refresh="refresh"
          />
          <Releases
            v-else-if="tab === 'releases'"
            :key="pid"
            :pid="pid"
            :tick="tick"
            :can-write="canWrite"
            @notify="notify"
            @refresh="refresh"
            @validate="navigate('validation')"
          />
          <Members
            v-else-if="tab === 'members'"
            :key="pid"
            :pid="pid"
            :admin="user.is_admin"
            :tick="tick"
            @notify="notify"
            @refresh="refresh"
          />
          <Audit
            v-else-if="tab === 'audit'"
            :key="pid"
            :pid="pid"
            :tick="tick"
            @error="fail"
          />
          <UsersPanel
            v-else-if="tab === 'users' && user.is_admin"
            :tick="tick"
            :user="user"
            @notify="notify"
            @refresh="refresh"
          />
        </template>
        <footer class="page-footer">
          <span>Protocol Studio</span><span>统一数据源，清晰的工程协作。</span
          ><span>VUE 3 + RUST + POSTGRESQL</span>
        </footer>
      </main>
    </div>
    <div
      v-if="toast"
      :class="['toast', { error: toast.error }]"
      :role="toast.error ? 'alert' : 'status'"
    >
      <AlertTriangle v-if="toast.error" :size="18" /><CheckCircle2
        v-else
        :size="18"
      /><span>{{ toast.message }}</span
      ><button class="icon-btn" aria-label="关闭提示" @click="toast = null">
        <X :size="16" />
      </button>
    </div>
    <ImportModal
      v-if="modal === 'import'"
      :pid="pid"
      :has-points="!!overview?.has_configuration"
      @close="modal = null"
      @done="importDone"
    />
    <CreateProject
      v-if="modal === 'project'"
      @close="modal = null"
      @done="projectCreated"
    />
    <CreateUser
      v-if="modal === 'user'"
      @close="modal = null"
      @done="userCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, provide } from "vue";
import Toast from "./components/Toast.vue";
import {
  Network,
  Layers3,
  Box,
  ChevronsUpDown,
  LayoutDashboard,
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
  LockKeyhole,
  Pencil,
} from "@lucide/vue";
import { api, roles, type Row } from "./api";
import { belongsToBoard } from "./domain/board";
import { boardTypes } from "./domain/project";
import Badge from "./components/Badge.vue";
import Empty from "./components/Empty.vue";
import Login from "./pages/Login.vue";
import TopologyWorkspace from "./pages/TopologyWorkspace.vue";
import ProjectTopology from "./pages/ProjectTopology.vue";
import ProjectConfig from "./components/ProjectConfig.vue";
import SqlWorkspace from "./pages/SqlWorkspace.vue";
import Validation from "./pages/Validation.vue";
import Releases from "./pages/Releases.vue";
import Members from "./pages/Members.vue";
import Audit from "./pages/Audit.vue";
import UsersPanel from "./pages/UsersPanel.vue";
import ImportModal from "./components/ImportModal.vue";
import CreateProject from "./components/CreateProject.vue";
import CreateUser from "./components/CreateUser.vue";
import { useProjectEditLock } from "./composables/useProjectEditLock";
import { permissionKey, useProjectPermissions } from "./composables/useProjectPermissions";
import { allowsBoard } from "./domain/permissions";
const nav = [
  { id: "overview", label: "项目拓扑", icon: LayoutDashboard },
  { id: "board", label: "板卡内部信息", icon: Box },
  { id: "devices", label: "项目设置", icon: Network },
  { id: "sql", label: "SQL 工作台", icon: Terminal },
  { id: "validation", label: "数据校验", icon: ShieldCheck },
  { id: "releases", label: "代码与版本", icon: FileCode2 },
  { id: "members", label: "成员与权限", icon: Users },
  { id: "audit", label: "操作记录", icon: History },
];
const descriptions: Record<string, string> = {
  overview: "按板卡类型展示项目组成、挂载数量与通信协议。",
  board: "选择板卡类型，维护内部信号、采集、转发及协议配置。",
  devices: "管理项目共享的板卡模板、协议、数据定义和来源。",
  sql: "用 SQL 查看数据关系，替代复杂的表格公式。",
  validation: "在配置进入工程之前，发现并定位数据问题。",
  releases: "从同一份数据生成配置，冻结每次交付的版本。",
  members: "按项目、板卡和协议分配成员的编辑范围。",
  audit: "记录数据与权限变化，追溯每一次操作。",
  users: "统一维护账号、登录权限与平台管理员。",
};
const user = ref<Row | null>(null),
  checking = ref(true),
  projects = ref<Row[]>([]),
  pid = ref(Number(localStorage.getItem("protocol-project")) || 0),
  tab = ref("overview"),
  overview = ref<Row | null>(null),
  graph = ref<Row | null>(null),
  boardId = ref(0),
  sheetLabel = ref("内部信号表"),
  overviewError = ref(""),
  tick = ref(0),
  toast = ref<{ message: string; error: boolean } | null>(null),
  modal = ref<string | null>(null),
  focus = ref<Row | null>(null),
  menu = ref(false);
const permissions = useProjectPermissions({ pid, user, tick });
provide(permissionKey, permissions);
const project = computed(() => projects.value.find((p) => p.id === pid.value)),
  canEditProject = computed(() => !!project.value && project.value.role !== "viewer" && permissions.eligible.value),
  report = computed(() => overview.value?.validation),
  types = computed(() => boardTypes(graph.value)),
  selectedBoard = computed(() =>
    types.value.find((b: Row) => b.id === boardId.value),
  ),
  pageTitle = computed(
    () => nav.find((n) => n.id === tab.value)?.label || "账号管理",
  );
const pageDescription = computed(() => descriptions[tab.value]);
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
  if (!leaveWorkspace()) return;
  void editLock.sync();
  tick.value++;
}
const workspaceDirty = ref(false);
const editLock = useProjectEditLock({
  pid, user, eligible: canEditProject, notify,
  acquired: () => { if (!workspaceDirty.value && !document.querySelector("dialog[open]")) tick.value++; },
});
provide("project-edit-lock", { ...editLock, eligible: canEditProject });
watch(() => editLock.state.value?.permissions, summary => { if (summary) permissions.acceptSummary(summary); });
const canWrite = computed(() => editLock.owned.value && !editLock.pending.value);
const canManageWrite = computed(() => canWrite.value && permissions.canManage.value);
const canStartHere = computed(() => canEditProject.value && (
  tab.value === "board" && selectedBoard.value
    ? allowsBoard(permissions.state.value, selectedBoard.value.model_id)
    : tab.value === "releases" ? permissions.canManage.value : true
));
const editStatusMessage = computed(() => {
  if (editLock.failure.value) return editLock.message.value;
  if (permissions.error.value) return permissions.error.value;
  if (permissions.state.value?.role === "engineer" && !permissions.eligible.value)
    return "尚未分配可编辑的板卡或协议，请联系管理员授权；当前可以查看和复制。";
  if (canEditProject.value && !canStartHere.value && !editLock.owned.value)
    return "当前页面不在你的编辑范围内，可以查看和复制；授权范围见“成员与权限”。";
  return editLock.message.value + (permissions.state.value?.edit_scope === "scoped" && permissions.eligible.value ? " · 仅限已授权板卡和协议" : "");
});
async function retryEditing() {
  await Promise.all([editLock.retry(), permissions.refresh()]);
}
async function endEditing() {
  if (workspaceDirty.value && !window.confirm("结束编辑会放弃尚未提交的点表修改，是否继续？")) return;
  if (await editLock.release()) {
    workspaceDirty.value = false;
    tick.value++;
    notify("已结束编辑，其他成员现在可以开始编辑。");
  }
}
function leaveWorkspace() {
  if (workspaceDirty.value && !window.confirm("有未保存的点表修改，是否放弃？")) return false;
  workspaceDirty.value = false;
  return true;
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (workspaceDirty.value) { event.preventDefault(); event.returnValue = ""; }
}
async function changeProject(event:Event) {
  const select = event.target as HTMLSelectElement;
  const wasDirty = workspaceDirty.value;
  if (!leaveWorkspace()) { select.value = String(pid.value); return; }
  if (!await editLock.release()) { workspaceDirty.value = wasDirty; select.value = String(pid.value); return; }
  pid.value = Number(select.value);
  navigate("overview");
}
function navigate(page: string) {
  if (page === tab.value) { menu.value = false; return true; }
  if (!leaveWorkspace()) return false;
  focus.value = null;
  tab.value = page;
  menu.value = false;
  return true;
}
function openSharedData() {
  if (!navigate("devices")) return;
  focus.value = { entity: "data_items", id: null };
}
function enterBoard(id: number) {
  if (tab.value === "board" && boardId.value === id) return;
  if (!leaveWorkspace()) return;
  boardId.value = id;
  navigate("board");
}
watch(pid, () => {
  boardId.value = 0;
  focus.value = null;
});
function expired() {
  user.value = null;
  focus.value = null;
  modal.value = null;
}
onMounted(async () => {
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("session-expired", expired);
  try {
    user.value = await api("/auth/me");
  } catch {
  } finally {
    checking.value = false;
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", beforeUnload);
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
  graph.value = null;
  overviewError.value = "";
  if (!id || !currentUser) return;
  Promise.all([
    api(`/projects/${id}/overview`),
    api(`/projects/${id}/topology`),
  ])
    .then(([data, topology]) => {
      if (cancelled) return;
      overview.value = data;
      graph.value = topology;
      if (!boardTypes(topology).some((t) => t.id === boardId.value))
        boardId.value =
          boardTypes(topology).find((t) => t.code === "UPM")?.id ||
          boardTypes(topology)[0]?.id ||
          0;
      if (
        tab.value === "board" &&
        !boardTypes(topology).some((b: Row) => b.id === boardId.value)
      )
        navigate("overview");
    })
    .catch((e) => {
      if (!cancelled) {
        overviewError.value = e.message;
        fail(e.message);
      }
    });
});
function openIssue(issue: Row) {
  if (!graph.value) return;
  if (issue.entity === "project_config") {
    navigate("devices");
    modal.value = "config";
    return;
  }
  const row = graph.value[issue.entity]?.find((r: Row) => r.id === issue.id);
  const candidates = types.value.filter(
    (b: Row) => row && belongsToBoard(graph.value!, b, issue.entity, row),
  );
  const board =
    candidates.find((b: Row) => b.id === boardId.value) || candidates[0];
  if (
    board &&
    !["board_models", "platform_signals", "protocol_contracts"].includes(
      issue.entity,
    )
  ) {
    boardId.value = board.id;
    tab.value = "board";
  } else tab.value = "devices";
  focus.value = { entity: issue.entity, id: issue.id };
}

function topologyConflict() {
  workspaceDirty.value = false;
  focus.value = null;
  refresh();
}
function topologyDone(merged = false) {
  workspaceDirty.value = false;
  focus.value = null;
  refresh();
  notify(merged ? "修改已提交，已自动合并其他成员的无关修改" : "修改已提交，关联配置已同步更新");
}
async function logout() {
  const wasDirty = workspaceDirty.value;
  if (!leaveWorkspace()) return;
  if (!await editLock.release()) { workspaceDirty.value = wasDirty; return; }
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
async function projectCreated(p: Row) {
  await editLock.release();
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
            :value="pid"
            @change="changeProject"
          >
            <option v-if="!projects.length" :value="0">尚未加入项目</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">
              {{ p.name }}
            </option>
          </select>
        </div>
        <ChevronsUpDown :size="15" />
      </div>
      <div class="nav-caption">当前项目</div>
      <nav class="workspace-nav" aria-label="项目与板卡导航">
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
          </button>
          <div
            v-if="item.id === 'board' && tab === 'board' && types.length"
            class="board-tree"
          >
            <button
              v-for="board in types"
              :key="board.id"
              :class="[
                'board-nav-item',
                { active: tab === 'board' && boardId === board.id },
              ]"
              :aria-current="
                tab === 'board' && boardId === board.id ? 'page' : undefined
              "
              @click="enterBoard(board.id)"
            >
              <Box :size="16" /><span>{{ board.name }}</span
              ><small>{{ board.code }}</small>
            </button>
          </div></template
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
    <div class="main-wrap" :class="{ 'board-layout': tab === 'board' }">
      <header class="topbar">
        <button
          class="mobile-menu icon-btn"
          aria-label="导航菜单"
          @click="menu = !menu"
        >
          <Menu />
        </button>
        <div class="breadcrumbs" aria-label="当前位置">
          <button class="crumb-button" @click="navigate('overview')">
            {{ project?.name || "协议管理平台" }}
          </button>
          <ChevronRight :size="14" />
          <template v-if="tab === 'board' && selectedBoard"
            ><span class="crumb-board">{{ selectedBoard.name }}</span
            ><ChevronRight :size="14" /><strong>{{
              sheetLabel
            }}</strong></template
          >
          <strong v-else>{{ pageTitle }}</strong>
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
        <div class="workspace-heading">
          <div v-if="project && tab !== 'users'" :class="['project-edit-status', { owned: editLock.owned.value, occupied: editLock.occupied.value }]" role="status" aria-live="polite">
            <LockKeyhole :size="16" /><span>{{ editStatusMessage }}</span>
            <button v-if="editLock.failure.value || permissions.error.value" class="button small" :disabled="editLock.checking.value || editLock.pending.value" @click="retryEditing">重试检查</button>
            <button v-if="editLock.owned.value" class="button small" :disabled="editLock.pending.value" @click="endEditing">结束编辑</button>
            <button v-else-if="canEditProject" class="button small" :disabled="!canStartHere || editLock.pending.value || editLock.occupied.value || !editLock.state.value" @click="editLock.acquire"><Pencil :size="14" />{{ editLock.pending.value ? '获取中…' : '开始编辑' }}</button>
          </div>
          <div class="page-heading">
            <div>
              <h1>{{ pageTitle }}</h1>
              <p>{{ pageDescription }}</p>
            </div>
            <div class="heading-actions">
              <button
                v-if="tab === 'devices' && project"
                class="button"
                @click="modal = 'config'"
              >
                项目 JSON 配置
              </button>
              <button
                v-if="tab === 'devices' && user.is_admin"
                class="button"
                @click="modal = 'project'"
              >
                <FolderPlus :size="16" />新建项目</button
              ><button
                v-if="['board', 'devices'].includes(tab) && canManageWrite"
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
          <div
            v-if="
              overviewError && ['overview', 'board', 'devices'].includes(tab)
            "
            class="notice danger"
            role="alert"
          >
            {{ overviewError
            }}<button class="text-button" @click="refresh">重试</button>
          </div>
          <ProjectTopology
            v-else-if="tab === 'overview'"
            :graph="graph"
            @board="enterBoard"
          />
          <TopologyWorkspace
            v-else-if="['board', 'devices'].includes(tab)"
            :key="`${pid}:${tab}`"
            :pid="pid"
            :graph="graph"
            :can-write="canWrite"
            :mode="tab === 'board' ? 'board' : 'settings'"
            :board-id="boardId"
            :focus="focus"
            @done="topologyDone"
            @conflict="topologyConflict"
            @error="fail"
            @board="enterBoard"
            @settings="openSharedData"
            @configuration="modal = 'config'"
            @sheet="sheetLabel = $event"
            @dirty="workspaceDirty = $event"
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
            :can-write="canManageWrite"
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
        <footer v-if="tab !== 'board'" class="page-footer">
          <span>Protocol Studio</span><span>统一数据源，清晰的工程协作。</span
          ><span>{{ project?.name }}</span>
        </footer>
      </main>
    </div>
    <Toast v-if="toast" :message="toast.message" :error="toast.error" @close="toast = null" />
    <ProjectConfig
      @error="fail"
      @conflict="modal = null; topologyConflict()"
      v-if="modal === 'config' && graph"
      :pid="pid"
      :graph="graph"
      :can-write="canManageWrite"
      @close="modal = null"
      @done="
        modal = null;
        topologyDone();
      "
    />
    <ImportModal
      v-if="modal === 'import'"
      :pid="pid"
      :can-write="canManageWrite"
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

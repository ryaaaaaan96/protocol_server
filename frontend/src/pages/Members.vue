<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { Shield, Code2, LockKeyhole, Plus } from "@lucide/vue";
import { api, roles, type Row } from "../api";
import Badge from "../components/Badge.vue";
import Empty from "../components/Empty.vue";
import MemberPermissions from "../components/MemberPermissions.vue";
const props = defineProps<{ pid: number; admin: boolean; tick: number }>();
const emit = defineEmits<{
  notify: [message: string, error?: boolean];
  refresh: [];
}>();
const members = ref<Row[]>([]),
  users = ref<Row[]>([]),
  uid = ref(""),
  role = ref("engineer"),
  busy = ref(false),
  loading = ref(false),
  catalog = ref<Row[] | null>(null),
  loadError = ref(""),
  edit = ref<{ member: Row; adding: boolean } | null>(null);
let request = 0;
async function load() {
  const current = ++request,
    pid = props.pid;
  loading.value = true;
  loadError.value = "";
  const results = await Promise.allSettled([
    api(`/projects/${pid}/members`),
    api(`/projects/${pid}/permissions`),
    props.admin ? api("/users") : Promise.resolve([]),
  ]);
  if (current !== request) return;
  loading.value = false;
  const errors: string[] = [];
  if (results[0].status === "fulfilled") members.value = results[0].value;
  else errors.push(`成员加载失败：${results[0].reason.message}`);
  if (results[1].status === "fulfilled")
    catalog.value = results[1].value.catalog;
  else {
    catalog.value = null;
    errors.push(`编辑范围加载失败：${results[1].reason.message}`);
  }
  if (results[2].status === "fulfilled") users.value = results[2].value;
  else {
    users.value = [];
    errors.push(`账号加载失败：${results[2].reason.message}`);
  }
  loadError.value = errors.join("；");
}
watch(
  () => [props.pid, props.tick, props.admin],
  (_, previous) => {
    if (previous?.[0] !== props.pid) {
      edit.value = null;
      members.value = [];
      catalog.value = null;
      uid.value = "";
    }
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => request++);
function scopeSummary(member: Row) {
  if (member.edit_scope !== "scoped") return "全部板卡与协议";
  const grants: Row[] = member.grants || [];
  if (!grants.length) return "未分配（只读）";
  return `${new Set(grants.map((grant) => grant.model_id)).size} 类板卡 · ${grants.length} 项授权`;
}
function configure(member: Row, adding = false) {
  if (!catalog.value || busy.value) return;
  edit.value = { member, adding };
}
function addMember() {
  const user = users.value.find((user) => user.id === Number(uid.value));
  if (!user || !props.admin) return;
  const existing = members.value.find((member) => member.id === user.id);
  configure(
    {
      ...user,
      edit_scope: "scoped",
      grants: [],
      ...existing,
      role: role.value,
    },
    !existing,
  );
}
function saved() {
  edit.value = null;
  uid.value = "";
  emit("refresh");
  emit("notify", "项目成员及编辑范围已保存");
}
async function assign(id: number, r: string) {
  if (!props.admin || busy.value) return false;
  const pid = props.pid;
  busy.value = true;
  try {
    await api(`/projects/${pid}/members`, "PUT", {
      user_id: id,
      role: r,
    });
    if (props.pid === pid) {
      members.value =
        r === "remove"
          ? members.value.filter((member) => member.id !== id)
          : members.value.map((member) =>
              member.id === id ? { ...member, role: r } : member,
            );
      emit("refresh");
      emit(
        "notify",
        r === "remove" ? "成员已移出项目" : "项目角色已更新，原编辑范围已保留",
      );
    }
    return true;
  } catch (e) {
    emit("notify", (e as Error).message, true);
    return false;
  } finally {
    busy.value = false;
  }
}
async function changeRole(member: Row, event: Event) {
  const select = event.target as HTMLSelectElement;
  if (!(await assign(member.id, select.value))) select.value = member.role;
}
</script>
<template>
  <div class="role-grid">
    <div
      v-for="item in [
        {
          title: '管理员',
          desc: '管理全平台账号、项目和成员权限。',
          icon: Shield,
        },
        {
          title: '工程师',
          desc: '按授权板卡与协议编辑；项目全部权限支持导入和发布。',
          icon: Code2,
        },
        {
          title: '只读成员',
          desc: '查看点表、运行只读查询、下载版本。',
          icon: LockKeyhole,
        },
      ]"
      :key="item.title"
      class="panel role-card"
    >
      <component :is="item.icon" :size="22" />
      <h3>{{ item.title }}</h3>
      <p>{{ item.desc }}</p>
    </div>
  </div>
  <section class="panel section-gap">
    <div class="panel-heading">
      <div>
        <h3>项目成员</h3>
        <p>
          按成员分配板卡与协议范围，未授权部分只读。平台管理员自动拥有全部权限。
        </p>
      </div>
      <Badge>{{ members.length }} 位成员</Badge>
    </div>
    <form v-if="admin" class="member-form" @submit.prevent="addMember">
      <select aria-label="选择账号" v-model="uid" required>
        <option value="">选择已有账号…</option>
        <option
          v-for="u in users.filter((u) => u.active && !u.is_admin)"
          :key="u.id"
          :value="u.id"
        >
          {{ u.display_name }} ({{ u.username }})
        </option></select
      ><select aria-label="分配角色" v-model="role">
        <option value="engineer">工程师</option>
        <option value="viewer">只读成员</option></select
      ><button
        class="button primary"
        :disabled="busy || loading || !uid || !catalog"
      >
        <Plus :size="16" />配置并添加 / 更新
      </button>
    </form>
    <div v-if="loadError" class="notice danger member-load-error" role="alert">
      <span>{{ loadError }}</span>
      <button
        type="button"
        class="text-button"
        :disabled="loading"
        @click="load"
      >
        重新加载
      </button>
    </div>
    <div v-if="members.length" class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>成员</th>
            <th>账号</th>
            <th>项目权限</th>
            <th>编辑范围</th>
            <th>状态</th>
            <th v-if="admin" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in members" :key="m.id">
            <td>
              <div class="inline">
                <div class="avatar pale">{{ m.display_name.slice(0, 1) }}</div>
                <strong>{{ m.display_name }}</strong>
              </div>
            </td>
            <td class="mono">{{ m.username }}</td>
            <td>
              <select
                v-if="admin"
                :aria-label="`${m.display_name}的权限`"
                :disabled="busy"
                :value="m.role"
                @change="changeRole(m, $event)"
              >
                <option value="engineer">工程师</option>
                <option value="viewer">只读成员</option></select
              ><Badge v-else>{{ roles[m.role] }}</Badge>
            </td>
            <td>
              <button
                class="text-button member-scope-button"
                :aria-label="`${m.display_name}的编辑范围：${scopeSummary(m)}`"
                :disabled="busy || loading || !catalog"
                @click="configure(m)"
              >
                {{ scopeSummary(m) }}
              </button>
              <small class="member-scope-note">{{
                m.role === "viewer"
                  ? "仅查看，授权范围暂不生效"
                  : admin
                    ? "点击分配板卡与协议"
                    : "点击查看授权详情"
              }}</small>
            </td>
            <td>
              <Badge :tone="m.active ? 'teal' : 'gray'">{{
                m.active ? "启用" : "已禁用"
              }}</Badge>
            </td>
            <td v-if="admin">
              <button
                class="text-button danger-text"
                :disabled="busy"
                @click="assign(m.id, 'remove')"
              >
                移出项目
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <Empty
      v-else-if="!loading && !loadError"
      title="还没有项目成员"
      :detail="
        admin
          ? '先在账号管理中创建账号，再分配至此项目。'
          : '项目管理员可以添加协作成员。'
      "
    />
    <p
      v-else-if="loading && !members.length"
      class="member-loading"
      role="status"
    >
      正在加载成员与编辑范围…
    </p>
  </section>
  <MemberPermissions
    v-if="edit && catalog"
    :key="`${pid}:${edit.member.id}`"
    :pid="pid"
    :member="edit.member"
    :catalog="catalog"
    :readonly="!admin"
    :adding="edit.adding"
    @close="edit = null"
    @saved="saved"
  />
</template>

<style scoped>
.member-scope-button {
  text-align: left;
  font-size: 13px;
  padding: 2px 0;
}
.member-scope-note {
  display: block;
  font-size: 11px;
  color: #738195;
  margin-top: 4px;
}
.member-load-error {
  margin: 0 20px 16px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.member-load-error span {
  flex: 1 1 280px;
}
.member-loading {
  padding: 10px 23px 24px;
  color: #738195;
}
</style>

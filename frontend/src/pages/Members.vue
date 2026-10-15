<script setup lang="ts">
import { ref, watch } from "vue";
import { Shield, Code2, LockKeyhole, Plus } from "@lucide/vue";
import { api, roles, type Row } from "../api";
import Badge from "../components/Badge.vue";
import Empty from "../components/Empty.vue";
const props = defineProps<{ pid: number; admin: boolean; tick: number }>();
const emit = defineEmits<{
  notify: [message: string, error?: boolean];
  refresh: [];
}>();
const members = ref<Row[]>([]),
  users = ref<Row[]>([]),
  uid = ref(""),
  role = ref("engineer"),
  busy = ref(false);
watch(
  () => [props.pid, props.tick],
  () => {
    api(`/projects/${props.pid}/members`)
      .then((v) => (members.value = v))
      .catch((e) => emit("notify", e.message, true));
    if (props.admin)
      api("/users")
        .then((v) => (users.value = v))
        .catch((e) => emit("notify", e.message, true));
  },
  { immediate: true },
);
async function assign(id: number, r: string) {
  busy.value = true;
  try {
    await api(`/projects/${props.pid}/members`, "PUT", {
      user_id: id,
      role: r,
    });
    emit("refresh");
    emit("notify", "项目成员权限已更新");
  } catch (e) {
    emit("notify", (e as Error).message, true);
  } finally {
    busy.value = false;
  }
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
          desc: '编辑项目测点、导入数据、创建版本。',
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
        <p>平台管理员自动拥有所有项目权限，无需重复分配。</p>
      </div>
      <Badge>{{ members.length }} 位成员</Badge>
    </div>
    <form
      v-if="admin"
      class="member-form"
      @submit.prevent="assign(Number(uid), role)"
    >
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
      ><button class="button primary" :disabled="busy || !uid">
        <Plus :size="16" />添加 / 更新成员
      </button>
    </form>
    <div v-if="members.length" class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>成员</th>
            <th>账号</th>
            <th>项目权限</th>
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
                @change="
                  assign(m.id, ($event.target as HTMLSelectElement).value)
                "
              >
                <option value="engineer">工程师</option>
                <option value="viewer">只读成员</option></select
              ><Badge v-else>{{ roles[m.role] }}</Badge>
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
      v-else
      title="还没有项目成员"
      :detail="
        admin
          ? '先在账号管理中创建账号，再分配至此项目。'
          : '项目管理员可以添加协作成员。'
      "
    />
  </section>
</template>

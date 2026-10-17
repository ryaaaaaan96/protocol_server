<script setup lang="ts">
import { computed, ref } from "vue";
import { api, type Row } from "../api";
import Modal from "./Modal.vue";
import Badge from "./Badge.vue";

type Grant = {
  model_id: number;
  scope: "board" | "internal" | "protocol";
  contract_id?: number;
};
const props = defineProps<{
  pid: number;
  member: Row;
  catalog: Row[];
  readonly?: boolean;
  adding?: boolean;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const editScope = ref<"all" | "scoped">(
  props.member.edit_scope === "scoped" ? "scoped" : "all",
);
const grants = ref<Grant[]>(
  (props.member.grants || []).map((grant: Grant) => ({ ...grant })),
);
const busy = ref(false),
  error = ref("");
const selectedBoards = computed(
  () => new Set(grants.value.map((grant) => grant.model_id)).size,
);
function granted(modelId: number, scope: Grant["scope"], contractId?: number) {
  return grants.value.some(
    (grant) =>
      grant.model_id === modelId &&
      grant.scope === scope &&
      (scope !== "protocol" || grant.contract_id === contractId),
  );
}
function toggle(modelId: number, scope: Grant["scope"], contractId?: number) {
  if (props.readonly || busy.value) return;
  const selected = granted(modelId, scope, contractId);
  grants.value = grants.value.filter(
    (grant) =>
      grant.model_id !== modelId ||
      (scope !== "board" &&
        (grant.scope !== scope ||
          (scope === "protocol" && grant.contract_id !== contractId))),
  );
  if (!selected)
    grants.value.push({
      model_id: modelId,
      scope,
      ...(scope === "protocol" ? { contract_id: contractId } : {}),
    });
}
function protocolDetails(protocol: Row) {
  const peers = (protocol.peer_models || []).map(
    (peer: Row) => peer.model_code || peer.model_name,
  );
  return [
    protocol.protocol,
    ...(protocol.transports || []),
    ...(protocol.endpoints || peers),
    protocol.code,
  ]
    .filter(Boolean)
    .join(" · ");
}
async function save() {
  if (props.readonly || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/projects/${props.pid}/members`, "PUT", {
      user_id: props.member.id,
      role: props.member.role,
      edit_scope: editScope.value,
      grants: grants.value,
    });
    emit("saved");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal
    :title="`${adding ? '添加成员' : '编辑范围'} · ${member.display_name}`"
    wide
    @close="!busy && emit('close')"
  >
    <form @submit.prevent="save">
      <div class="modal-body member-permissions">
        <p class="member-identity">
          <span class="mono">{{ member.username }}</span>
          <Badge>{{
            member.role === "engineer" ? "工程师" : "只读成员"
          }}</Badge>
          <Badge v-if="!member.active" tone="gray">账号已禁用</Badge>
        </p>
        <p v-if="!member.active" class="notice">
          账号已禁用，当前无法登录或编辑。此处可维护账号恢复后的授权范围。
        </p>
        <p v-if="member.role !== 'engineer'" class="notice">
          此成员当前只能查看。编辑范围会保留，改为工程师后生效。
        </p>
        <fieldset class="scope-mode" :disabled="readonly || busy">
          <legend>允许编辑的范围</legend>
          <label
            :class="['scope-mode-choice', { selected: editScope === 'scoped' }]"
          >
            <input
              v-model="editScope"
              type="radio"
              value="scoped"
              name="edit-scope"
            />
            <span
              ><strong>指定板卡与协议</strong
              ><small>仅勾选的范围可编辑，其他范围只读。</small></span
            >
          </label>
          <label
            :class="['scope-mode-choice', { selected: editScope === 'all' }]"
          >
            <input
              v-model="editScope"
              type="radio"
              value="all"
              name="edit-scope"
            />
            <span
              ><strong>项目全部</strong
              ><small
                >包含所有板卡、协议，以及项目配置、导入和版本发布。</small
              ></span
            >
          </label>
        </fieldset>
        <template v-if="editScope === 'scoped'">
          <div class="scope-heading">
            <strong>按板卡分配</strong>
            <span>已授权 {{ selectedBoards }} 类板卡</span>
          </div>
          <p class="scope-help">
            内部点表包含信号与处理配置；协议范围包含对应的采集和转发点表。共享数据的修改需要拥有全部受影响范围的权限。
          </p>
          <div v-if="!catalog.length" class="notice">
            项目还没有板卡，可在添加板卡后分配范围。
          </div>
          <fieldset
            v-for="board in catalog"
            :key="board.model_id"
            class="scope-board"
            :disabled="readonly || busy"
          >
            <legend>
              {{ board.model_name }}
              <span class="mono">{{ board.model_code }}</span>
            </legend>
            <label class="scope-option scope-whole">
              <input
                type="checkbox"
                :checked="granted(board.model_id, 'board')"
                @change="toggle(board.model_id, 'board')"
              />
              <span
                ><strong>整个板卡</strong
                ><small
                  >包含内部点表与全部协议，后续新增协议也适用。</small
                ></span
              >
            </label>
            <div class="scope-details">
              <label class="scope-option">
                <input
                  type="checkbox"
                  :checked="
                    granted(board.model_id, 'board') ||
                    granted(board.model_id, 'internal')
                  "
                  :disabled="granted(board.model_id, 'board')"
                  @change="toggle(board.model_id, 'internal')"
                />
                <span
                  ><strong>内部点表</strong><small>信号与处理配置</small></span
                >
              </label>
              <label
                v-for="protocol in board.protocols"
                :key="protocol.contract_id"
                class="scope-option"
              >
                <input
                  type="checkbox"
                  :checked="
                    granted(board.model_id, 'board') ||
                    granted(board.model_id, 'protocol', protocol.contract_id)
                  "
                  :disabled="granted(board.model_id, 'board')"
                  @change="
                    toggle(board.model_id, 'protocol', protocol.contract_id)
                  "
                />
                <span
                  ><strong>{{ protocol.name }}</strong
                  ><small>{{ protocolDetails(protocol) }}</small></span
                >
              </label>
            </div>
          </fieldset>
          <p v-if="!grants.length" class="notice">
            尚未勾选任何范围，此成员将只能查看项目。
          </p>
        </template>
        <p v-else class="scope-help">
          “项目全部”也包括以后新增的板卡与协议；平台管理员始终拥有全部权限。
        </p>
        <p class="scope-help">
          有编辑权限的成员仍需先获取项目编辑权。同一项目每次由一人编辑，提交成功后释放。
        </p>
        <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
      </div>
      <div class="modal-footer">
        <button
          type="button"
          class="button"
          :disabled="busy"
          @click="emit('close')"
        >
          {{ readonly ? "关闭" : "取消" }}
        </button>
        <button v-if="!readonly" class="button primary" :disabled="busy">
          {{
            busy ? "保存中…" : adding ? "添加成员并保存范围" : "保存编辑范围"
          }}
        </button>
      </div>
    </form>
  </Modal>
</template>

<style scoped>
.member-permissions {
  display: grid;
  gap: 14px;
}
.member-identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
  margin: 0;
}
.member-permissions .notice {
  margin: 0;
}
.scope-mode {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.scope-mode legend {
  font-weight: 650;
  margin-bottom: 10px;
}
.scope-mode-choice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  border: 1px solid #dce4ea;
  border-radius: 7px;
  padding: 12px;
  cursor: pointer;
}
.scope-mode-choice.selected {
  border-color: #6b9e90;
  background: #f1f8f5;
}
.scope-mode-choice span,
.scope-option span {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.scope-mode-choice strong,
.scope-option strong {
  font-weight: 600;
  font-size: 13px;
}
.scope-mode-choice small,
.scope-option small {
  font-size: 12px;
  color: #64758a;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.member-permissions input[type="checkbox"],
.member-permissions input[type="radio"] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  padding: 0;
  margin: 2px 0 0;
  accent-color: #397d66;
}
.scope-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.scope-heading span {
  color: #64758a;
  font-size: 12px;
}
.scope-help {
  margin: 0;
  color: #64758a;
  font-size: 12px;
  line-height: 1.7;
}
.scope-board {
  margin: 0;
  border: 1px solid #dce4ea;
  border-radius: 7px;
  padding: 10px 14px;
  min-width: 0;
}
.scope-board legend {
  padding: 0 5px;
  font-weight: 600;
  font-size: 14px;
}
.scope-board legend span {
  margin-left: 5px;
  color: #64758a;
  font-size: 12px;
  font-weight: 400;
}
.scope-option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 9px 0;
  cursor: pointer;
}
.scope-whole {
  padding-top: 2px;
  padding-bottom: 11px;
}
.scope-details {
  border-top: 1px solid #e6ebef;
  margin-left: 26px;
}
fieldset:disabled label,
.scope-option:has(input:disabled) {
  cursor: default;
}
@media (max-width: 640px) {
  .scope-mode {
    grid-template-columns: 1fr;
  }
  .scope-board {
    padding: 9px 10px;
  }
  .scope-details {
    margin-left: 12px;
  }
}
</style>

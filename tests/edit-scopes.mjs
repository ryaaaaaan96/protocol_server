// Real HTTP writes, previews, leases and role changes against integration.mjs's
// disposable PostgreSQL database. A granted endpoint must not become a route to
// other protocols, boards, shared definitions or project-level operations.
import pg from "../.runtime/db-tools/node_modules/pg/lib/index.js";

export async function checkEditScopes({
  client,
  engineer,
  viewer,
  engineerId,
  viewerId,
  password,
  migrationUrl,
  equal,
  ok,
}) {
  const project = await client.call("/projects", "POST", {
    name: "Scoped editors",
  });
  const url = `/projects/${project.id}`;
  const graph = () => client.call(`${url}/topology`);
  const preview = async (who, entity, values, id = null) =>
    who.raw(`${url}/changes/preview`, "POST", {
      revision: (await graph()).revision,
      entity,
      operation: id ? "update" : "create",
      id,
      values,
    });
  const edit = async (entity, values, id = null) => {
    const p = await preview(client, entity, values, id);
    equal(p.status, 200);
    ok(p.data.allowed, JSON.stringify(p.data));
    return (await client.call(`${url}/changes/${p.data.id}/commit`, "POST", {}))
      .record;
  };
  const models = (await graph()).board_models;
  const a = models.find(model => model.code === "SCOPE_A"),
    b = models.find(model => model.code === "SCOPE_B");
  const ga = await edit("signal_groups", {
      model_id: a.id,
      name: "A internal",
      code: "MAIN",
    }),
    gb = await edit("signal_groups", {
      model_id: b.id,
      name: "B internal",
      code: "MAIN",
    });
  const item = await edit("data_items", {
    name: "Shared definition",
    data_type: "U16",
    byte_length: 2,
    min_value: "0",
    max_value: "100",
  });
  const sa = await edit("signals", {
    group_id: ga.id,
    data_item_id: item.id,
    name: "A signal",
    enum_name: "SCOPE_SIGNAL_A",
    sig_id: 101,
  });
  const sa2 = await edit("signals", {
    group_id: ga.id,
    data_item_id: item.id,
    name: "A second signal",
    enum_name: "SCOPE_SIGNAL_A2",
    sig_id: 102,
  });
  const sb = await edit("signals", {
    group_id: gb.id,
    data_item_id: item.id,
    name: "B signal",
    enum_name: "SCOPE_SIGNAL_B",
    sig_id: 201,
  });
  const sb2 = await edit("signals", {
    group_id: gb.id,
    data_item_id: item.id,
    name: "B second signal",
    enum_name: "SCOPE_SIGNAL_B2",
    sig_id: 202,
  });
  const x = await edit("protocol_contracts", {
      name: "CANFD Modbus",
      code: "SCOPE_X",
      protocol: "MODBUS",
    }),
    y = await edit("protocol_contracts", {
      name: "RS485 Modbus",
      code: "SCOPE_Y",
      protocol: "MODBUS",
    });
  const ax = await edit("endpoints", {
    model_id: a.id,
    contract_id: x.id,
    name: "A X",
    code: "AX",
    role: "client",
    transport: "CANFD",
  });
  const ay = await edit("endpoints", {
    model_id: a.id,
    contract_id: y.id,
    name: "A Y",
    code: "AY",
    role: "client",
    transport: "RS485",
  });
  await edit("endpoints", {
    model_id: b.id,
    contract_id: x.id,
    name: "B X",
    code: "BX",
    role: "server",
    transport: "CANFD",
  });
  const ca = await edit("device_contexts", {
    model_id: a.id,
    group_id: ga.id,
    name: "A local",
    code: "LOCAL",
    dev_id: 1,
    kind: "local",
  });
  const fx = await edit("protocol_fields", {
    contract_id: x.id,
    data_item_id: item.id,
    name: "X field",
    address_mode: "manual",
    address: 0,
    ordinal: 1,
  });
  const fy = await edit("protocol_fields", {
    contract_id: y.id,
    data_item_id: item.id,
    name: "Y field",
    address_mode: "manual",
    address: 0,
    ordinal: 1,
  });
  const fy2 = await edit("protocol_fields", {
    contract_id: y.id,
    data_item_id: item.id,
    name: "Y alternate field",
    address_mode: "manual",
    address: 1,
    ordinal: 2,
  });
  const bx = await edit("signal_bindings", {
    endpoint_id: ax.id,
    context_id: ca.id,
    field_id: fx.id,
    signal_id: sa.id,
    poll_interval: 1,
  });
  const by = await edit("signal_bindings", {
    endpoint_id: ay.id,
    context_id: ca.id,
    field_id: fy.id,
    signal_id: sa.id,
    poll_interval: 1,
  });
  const grant = (model_id, scope, contract_id) => ({
    model_id,
    scope,
    ...(contract_id ? { contract_id } : {}),
  });
  const assign = async (grants, extra = {}) =>
    client.call(`${url}/members`, "PUT", {
      user_id: engineerId,
      role: "engineer",
      edit_scope: "scoped",
      grants,
      ...extra,
    });
  await client.call(`${url}/members`, "PUT", {
    user_id: viewerId,
    role: "viewer",
    edit_scope: "all",
  });
  await assign([grant(a.id, "protocol", x.id)]);
  let permissions = await engineer.call(`${url}/permissions`);
  equal(permissions.can_edit, true);
  equal(permissions.can_manage_project, false);
  equal(permissions.edit_scope, "scoped");
  equal(permissions.catalog.length, 2);
  equal(
    permissions.catalog.find((m) => m.model_id === a.id).protocols.length,
    2,
  );
  ok(
    permissions.catalog
      .find((m) => m.model_id === a.id)
      .protocols.find((c) => c.contract_id === x.id)
      .transports.includes("CANFD"),
  );
  equal((await viewer.call(`${url}/permissions`)).can_edit, false);
  equal(
    (await engineer.call(`${url}/topology`)).permissions.grants[0].contract_id,
    x.id,
  );
  let table = await engineer.call(
    `${url}/board-models/${a.id}/point-tables/collect`,
  );
  equal(table.rows.find((r) => r.id === bx.id).can_edit, true);
  equal(table.rows.find((r) => r.id === by.id).can_edit, false);
  equal(
    (await engineer.call(`${url}/board-models/${b.id}/point-tables/process`))
      .rows[0].can_edit,
    false,
  );
  const deny = async (entity, values, id) => {
    const result = await preview(engineer, entity, values, id);
    equal(result.status, 403);
    equal(result.data.code, "EDIT_SCOPE_DENIED");
    ok(result.data.required.length > 0);
    return result;
  };
  const good = await preview(
    engineer,
    "signal_bindings",
    { poll_interval: 3 },
    bx.id,
  );
  equal(good.status, 200);
  equal(good.data.allowed, true);
  await engineer.call(`${url}/changes/${good.data.id}/commit`, "POST", {});
  await deny("signal_bindings", { poll_interval: 4 }, by.id);
  await deny(
    "signal_bindings",
    { endpoint_id: ay.id, field_id: fy2.id },
    bx.id,
  );
  await deny("signals", { flags: "1" }, sa.id);
  await deny("data_items", { unit: "V" }, item.id);
  const shared = await deny("protocol_fields", { scale: 2 }, fx.id);
  ok(
    shared.data.required.some(
      (r) => r.model_id === b.id && r.contract_id === x.id,
    ),
  );
  // Batch must roll back an allowed first row if another row crosses a protocol.
  const beforeBatch = await graph();
  const batch = await engineer.raw(
    `${url}/board-models/${a.id}/point-tables/collect/batch/preview`,
    "POST",
    {
      revision: beforeBatch.revision,
      operation: "update",
      rows: [
        { row: 1, id: bx.id, values: { poll_interval: 8 } },
        { row: 2, id: by.id, values: { poll_interval: 9 } },
      ],
    },
  );
  equal(batch.status, 403);
  equal((await graph()).revision, beforeBatch.revision);
  equal(
    (await graph()).signal_bindings.find((r) => r.id === bx.id).poll_interval,
    3,
  );
  // A grant to both endpoints of a shared contract allows shared field edits.
  await assign([grant(a.id, "protocol", x.id), grant(b.id, "protocol", x.id)]);
  const sharedAllowed = await preview(
    engineer,
    "protocol_fields",
    { scale: 2 },
    fx.id,
  );
  equal(sharedAllowed.data.allowed, true);
  await engineer.call(
    `${url}/changes/${sharedAllowed.data.id}/commit`,
    "POST",
    {},
  );
  await assign([grant(a.id, "internal")]);
  const internal = await preview(
    engineer,
    "process_points",
    { model_id: a.id, fields: { min_value: "1" } },
    sa.id,
  );
  equal(internal.status, 200);
  equal(internal.data.allowed, true);
  await engineer.call(`${url}/changes/${internal.data.id}/commit`, "POST", {});
  await deny("signals", { group_id: gb.id }, sa2.id);
  // Internal sigID changes propagate into protocol mappings and need those grants.
  await deny("signals", { sig_id: 103 }, sa.id);
  const otherOrder = await engineer.raw(
    `${url}/board-models/${b.id}/point-tables/process/reorder/preview`,
    "POST",
    { revision: (await graph()).revision, ids: [sb2.id, sb.id] },
  );
  equal(otherOrder.status, 403);
  await assign([grant(a.id, "board")]);
  const own = await preview(engineer, "signals", { sig_id: 103 }, sa.id);
  equal(own.data.allowed, true);
  await engineer.call(`${url}/changes/${own.data.id}/commit`, "POST", {});
  await deny("data_items", { unit: "A" }, item.id);
  await deny("project_config", { config: (await graph()).project_config });
  const form = new FormData();
  form.append("file", new Blob(["no xlsx"]), "bad.xlsx");
  equal(
    (await engineer.raw(`${url}/imports/preview`, "POST", form)).status,
    403,
  );
  equal(
    (
      await engineer.raw(`${url}/imports/123456/commit`, "POST", {
        replace: true,
      })
    ).status,
    403,
  );
  equal(
    (
      await engineer.raw(`${url}/releases`, "POST", {
        name: "forbidden",
        revision: (await graph()).revision,
      })
    ).status,
    403,
  );
  equal(
    (
      await engineer.raw(`${url}/members`, "PUT", {
        user_id: engineerId,
        role: "engineer",
        edit_scope: "all",
      })
    ).status,
    403,
  );
  // Revoke after preview while retaining a different grant and the same lease.
  const revocable = await preview(engineer, "signals", { flags: "2" }, sa2.id);
  equal(revocable.data.allowed, true);
  await assign([grant(b.id, "internal")]);
  const deniedCommit = await engineer.raw(
    `${url}/changes/${revocable.data.id}/commit`,
    "POST",
    {},
  );
  equal(deniedCommit.status, 403);
  equal(deniedCommit.data.code, "EDIT_SCOPE_DENIED");
  equal((await graph()).signals.find((s) => s.id === sa2.id).flags, "0");
  // A role-only change preserves the explicit scopes and does not escalate.
  await client.call(`${url}/members`, "PUT", {
    user_id: engineerId,
    role: "viewer",
  });
  await client.call(`${url}/members`, "PUT", {
    user_id: engineerId,
    role: "engineer",
  });
  permissions = await engineer.call(`${url}/permissions`);
  equal(permissions.edit_scope, "scoped");
  equal(permissions.grants[0].model_id, b.id);
  const other = await client.call("/projects", "POST", {
    name: "Foreign grant target",
  });
  const foreign = await client.call(
    `/projects/${other.id}/changes/preview`,
    "POST",
    {
      revision: 1,
      entity: "board_models",
      operation: "create",
      values: { name: "Foreign", code: "FOREIGN" },
    },
  );
  const foreignModel = (
    await client.call(
      `/projects/${other.id}/changes/${foreign.id}/commit`,
      "POST",
      {},
    )
  ).record;
  for (const grants of [
    [grant(foreignModel.id, "board")],
    [grant(b.id, "protocol", y.id)],
    [grant(a.id, "internal", x.id)],
    [grant(a.id, "protocol")],
    [grant(a.id, "board"), grant(a.id, "board")],
  ]) {
    equal(
      (
        await client.raw(`${url}/members`, "PUT", {
          user_id: engineerId,
          role: "engineer",
          edit_scope: "scoped",
          grants,
        })
      ).status,
      400,
    );
  }
  equal((await engineer.call(`${url}/permissions`)).grants[0].model_id, b.id);
  await engineer.rawUnlocked(`${url}/edit-lock/acquire`, "POST", {});
  await assign([]);
  const lock = (await engineer.rawUnlocked(`${url}/edit-lock`)).data;
  equal(lock.locked, false);
  equal(lock.permissions.can_edit, false);
  equal(
    (await engineer.rawUnlocked(`${url}/edit-lock/acquire`, "POST", {})).status,
    403,
  );
  equal(
    (await client.rawUnlocked(`${url}/edit-lock/acquire`, "POST", {})).status,
    200,
  );
  await client.rawUnlocked(`${url}/edit-lock/release`, "POST", {});
  // A global admin-role downgrade serializes behind a project write already in
  // progress; it cannot cross a cached all-scopes decision inside that write.
  if (migrationUrl && password) {
    await assign([grant(a.id, "internal")]);
    await client.call(`/users/${engineerId}`, "PUT", {
      active: true,
      is_admin: true,
    });
    await engineer.call("/auth/login", "POST", {
      username: "engineer",
      password,
    });
    await engineer.rawUnlocked(`${url}/edit-lock/acquire`, "POST", {});
    const blocking = new pg.Client({ connectionString: migrationUrl });
    const observer = new pg.Client({ connectionString: migrationUrl });
    await blocking.connect();
    await observer.connect();
    let draftPending, revocationPending;
    try {
      await blocking.query("BEGIN");
      await blocking.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
        project.id,
      ]);
      draftPending = engineer.rawUnlocked(`${url}/changes/preview`, "POST", {
        revision: (await graph()).revision,
        entity: "signals",
        operation: "update",
        id: sb.id,
        values: { flags: "4" },
      });
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        waiting = (
          await observer.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT revision FROM projects%') AS yes",
          )
        ).rows[0].yes;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      ok(waiting, "project writer is waiting after taking its actor lock");
      let revoked = false;
      revocationPending = client
        .rawUnlocked(`/users/${engineerId}`, "PUT", {
          active: true,
          is_admin: false,
        })
        .then((r) => {
          revoked = true;
          return r;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      equal(revoked, false);
      await blocking.query("COMMIT");
      const permitted = await draftPending;
      equal(permitted.status, 200);
      equal(permitted.data.allowed, true);
      equal((await revocationPending).status, 200);
      // Revocation removes sessions and the next commit must use refreshed scopes.
      await engineer.call("/auth/login", "POST", {
        username: "engineer",
        password,
      });
      const deniedAfter = await engineer.rawUnlocked(
        `${url}/changes/${permitted.data.id}/commit`,
        "POST",
        {},
      );
      equal(deniedAfter.status, 403);
      equal(deniedAfter.data.code, "EDIT_SCOPE_DENIED");
      await engineer.rawUnlocked(`${url}/edit-lock/release`, "POST", {});
    } finally {
      await blocking.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([draftPending, revocationPending]);
      await blocking.end();
      await observer.end();
    }
  }
  // Default all remains backward compatible for existing integrations.
  await assign([], { edit_scope: "all" });
  const all = await engineer.call(`${url}/permissions`);
  equal(all.can_manage_project, true);
  const any = await preview(engineer, "signals", { flags: "3" }, sb.id);
  equal(any.data.allowed, true);
  console.log(
    "PASS: scoped board/contract authorization, shared impacts, batches, revocation, grants and read-only access",
  );
}

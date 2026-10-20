use crate::{
    AppState,
    auth::User,
    db,
    error::{AppError, Result},
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlparser::{
    ast::{self, BinaryOperator, Expr, Query, SetExpr, Statement, TableFactor, Visit, Visitor},
    dialect::PostgreSqlDialect,
    parser::Parser,
};
use std::{
    collections::{BTreeSet, VecDeque},
    ops::ControlFlow,
};

const RELATIONS: &[&str] = &[
    "points.process_points",
    "points.transmit_points",
    "history.events",
];
// Legacy unqualified point queries and the short events name are resolved only
// through the project pool's fixed, trusted search_path.
const SHORT_RELATIONS: &[&str] = &["process_points", "transmit_points", "events"];
const FUNCTIONS: &[&str] = &[
    "count",
    "sum",
    "min",
    "max",
    "avg",
    "round",
    "abs",
    "ceil",
    "floor",
    "coalesce",
    "nullif",
    "lower",
    "upper",
    "length",
    "concat",
    "concat_ws",
    "replace",
    "substring",
    "trim",
    "row_number",
    "rank",
    "dense_rank",
    "lag",
    "lead",
    "first_value",
    "last_value",
    "string_agg",
    "array_agg",
    "greatest",
    "least",
];
struct Guard {
    scopes: Vec<QueryScope>,
}
struct QueryScope {
    visible: BTreeSet<String>,
    // Addresses identify immutable AST nodes; they are never dereferenced.
    // A non-recursive CTE enters scope only after its complete body is checked.
    pending: VecDeque<(*const Query, String)>,
}
fn identifier_name(identifier: &ast::Ident) -> String {
    if identifier.quote_style.is_some() {
        identifier.value.clone()
    } else {
        identifier.value.to_lowercase()
    }
}
// TABLE shortcuts are not relation nodes in every parser AST variant. Validate
// every set operand explicitly rather than relying only on relation visitors.
fn query_body(body: &SetExpr) -> ControlFlow<String> {
    match body {
        SetExpr::Select(select) if select.into.is_some() => {
            ControlFlow::Break("不允许 SELECT INTO".into())
        }
        SetExpr::Select(_) | SetExpr::Values(_) | SetExpr::Query(_) => ControlFlow::Continue(()),
        SetExpr::SetOperation { left, right, .. } => {
            query_body(left)?;
            query_body(right)
        }
        _ => ControlFlow::Break("仅允许 SELECT / WITH 查询，不允许 TABLE 简写或数据修改".into()),
    }
}
impl Visitor for Guard {
    type Break = String;
    fn pre_visit_statement(&mut self, s: &Statement) -> ControlFlow<String> {
        if !matches!(s, Statement::Query(_)) {
            return ControlFlow::Break("SQL 工作台仅允许单条 SELECT / WITH 查询".into());
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_query(&mut self, q: &Query) -> ControlFlow<String> {
        if !q.locks.is_empty() {
            return ControlFlow::Break("不允许锁定数据".into());
        }
        let mut pending = VecDeque::new();
        if let Some(w) = &q.with {
            if w.recursive {
                return ControlFlow::Break("SQL 工作台暂不支持 WITH RECURSIVE".into());
            }
            let mut names = BTreeSet::new();
            for c in &w.cte_tables {
                let name = identifier_name(&c.alias.name);
                if !names.insert(name.clone()) {
                    return ControlFlow::Break("同一 WITH 中的名称不能重复".into());
                }
                pending.push_back((c.query.as_ref() as *const Query, name));
            }
        }
        self.scopes.push(QueryScope {
            visible: BTreeSet::new(),
            pending,
        });
        query_body(&q.body)?;
        ControlFlow::Continue(())
    }
    fn post_visit_query(&mut self, q: &Query) -> ControlFlow<String> {
        self.scopes.pop();
        if let Some(parent) = self.scopes.last_mut()
            && parent
                .pending
                .front()
                .is_some_and(|(body, _)| std::ptr::eq(*body, q))
        {
            let (_, name) = parent.pending.pop_front().unwrap();
            parent.visible.insert(name);
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_relation(&mut self, n: &ast::ObjectName) -> ControlFlow<String> {
        let identifiers: Option<Vec<String>> = n
            .0
            .iter()
            .map(|part| match part {
                ast::ObjectNamePart::Identifier(identifier) => Some(identifier_name(identifier)),
                _ => None,
            })
            .collect();
        let allowed = match identifiers.as_deref() {
            Some([name]) => {
                SHORT_RELATIONS.contains(&name.as_str())
                    || self.scopes.iter().any(|scope| scope.visible.contains(name))
            }
            Some([schema, name]) => RELATIONS.contains(&format!("{schema}.{name}").as_str()),
            _ => false,
        };
        if !allowed {
            return ControlFlow::Break(format!("不可访问对象 {n}，仅允许当前项目的点表和历史事件"));
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_table_factor(&mut self, t: &TableFactor) -> ControlFlow<String> {
        if !matches!(
            t,
            TableFactor::Table { args: None, .. }
                | TableFactor::Derived { .. }
                | TableFactor::NestedJoin { .. }
        ) {
            return ControlFlow::Break("不允许表函数或外部数据源".into());
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<String> {
        match e {
            Expr::BinaryOp {
                op: BinaryOperator::Custom(_) | BinaryOperator::PGCustomBinaryOperator(_),
                ..
            } => {
                return ControlFlow::Break("不允许自定义操作符".into());
            }
            Expr::Function(f)
                if !FUNCTIONS.contains(&f.name.to_string().to_lowercase().as_str()) =>
            {
                return ControlFlow::Break(format!("不允许函数 {}", f.name));
            }
            Expr::Cast { data_type, .. } => {
                let t = data_type.to_string().to_lowercase();
                if ![
                    "text",
                    "integer",
                    "int",
                    "bigint",
                    "smallint",
                    "boolean",
                    "float",
                    "double precision",
                    "real",
                    "numeric",
                    "decimal",
                    "varchar",
                ]
                .iter()
                .any(|x| t == *x)
                {
                    return ControlFlow::Break("不允许此类型转换".into());
                }
            }
            Expr::TypedString { .. } => {
                return ControlFlow::Break("请使用普通字符串或基本类型 CAST".into());
            }
            _ => {}
        }
        ControlFlow::Continue(())
    }
}
pub fn check(sql: &str) -> Result<String> {
    if sql.len() > 20000 {
        return Err(AppError::bad("SQL 最多 20000 字符"));
    }
    let statements = Parser::parse_sql(&PostgreSqlDialect {}, sql)
        .map_err(|e| AppError::bad(format!("SQL 语法错误：{e}")))?;
    if statements.len() != 1 {
        return Err(AppError::bad("每次只能执行一条查询"));
    }
    let mut g = Guard { scopes: Vec::new() };
    if let ControlFlow::Break(e) = statements[0].visit(&mut g) {
        return Err(AppError::bad(e));
    }
    // Render the validated AST, never execute unparsed trailing source.
    Ok(statements[0].to_string())
}
#[derive(Deserialize)]
pub struct SqlInput {
    sql: String,
}
pub async fn execute(
    State(state): State<AppState>,
    user: User,
    Path(pid): Path<i64>,
    Json(input): Json<SqlInput>,
) -> Result<Json<Value>> {
    let sql = check(&input.sql)?;
    let mut tx = db::context(&state.pool, &user, Some(pid), false).await?;
    // Context authorization reads have already occurred; transaction_read_only can
    // still be set before any write. RLS plus a project setting bounds every row.
    sqlx::query("SET LOCAL transaction_read_only=on")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL work_mem='8MB'")
        .execute(&mut *tx)
        .await?;
    let start = std::time::Instant::now();
    let result: std::result::Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(&format!(
        "SELECT to_jsonb(result) FROM ({sql}) AS result LIMIT 501"
    ))
    .fetch_all(&mut *tx)
    .await;
    match result {
        Ok(mut rows) => {
            let truncated = rows.len() > 500;
            rows.truncate(500);
            tx.commit().await?;
            Ok(Json(
                json!({"rows":rows,"truncated":truncated,"elapsed_ms":start.elapsed().as_millis()}),
            ))
        }
        Err(e) => {
            tx.rollback().await?;
            Err(AppError::bad(format!(
                "查询失败：{}",
                e.as_database_error()
                    .map(|v| v.message().to_owned())
                    .unwrap_or_else(|| "数据库连接异常".into())
            )))
        }
    }
}
pub async fn definitions(_user: User) -> Json<Value> {
    Json(json!({"sql": concat!(
        "-- 项目结构迁移源码，按版本顺序展示；最终分组为 points、history、meta。\n",
        include_str!("../migrations/project/0001_project.sql"),
        "\n-- 以下迁移应用分组和表合并。\n",
        include_str!("../migrations/project/0002_grouped_project.sql")
    ), "relations": RELATIONS, "examples": [
        {"name":"DSP 内部数据", "sql":"SELECT board_key,group_key,name,enum_name,sig_id,internal_type FROM points.process_points ORDER BY board_key,display_order,id"},
        {"name":"DSP 转发映射", "sql":"SELECT p.name,t.endpoint_key,t.address,t.wire_type,p.enum_name FROM points.transmit_points t JOIN points.process_points p ON p.id=t.process_point_id ORDER BY t.endpoint_key,t.address"},
        {"name":"点表历史", "sql":"SELECT * FROM history.events WHERE kind='point' ORDER BY id DESC LIMIT 100"}
    ]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_privilege_escapes() {
        for sql in [
            "DELETE FROM points",
            "SELECT * FROM users",
            "SELECT set_config('app.user_id','1',true)",
            "SELECT * FROM pg_catalog.pg_roles",
            "SELECT 1; SELECT 2",
            "WITH x AS (DELETE FROM points RETURNING *) SELECT * FROM x",
            "SELECT pg_sleep(9)",
            "SELECT * FROM generate_series(1,100)",
            "SELECT 'users'::regclass",
            "COPY points TO '/tmp/leak'",
        ] {
            assert!(check(sql).is_err(), "{sql}");
        }
    }
    #[test]
    fn authorization_context_and_platform_objects_cannot_be_queried_or_changed() {
        for sql in [
            "SELECT set_config('app.access','{\"role\":\"admin\"}',true)",
            "SELECT pg_catalog.set_config('app.project_id','2',false)",
            "SELECT current_setting('app.actor_name')",
            "SELECT app_access()",
            "SELECT app_is_admin()",
            "SELECT app_project_identity()",
            "SELECT * FROM app_project_registry(1)",
            "SELECT * FROM app_lock_project(1)",
            "SELECT * FROM project_state",
            "SELECT * FROM meta.project_state",
            "SELECT * FROM meta.previews",
            "SELECT * FROM history.releases",
            "SELECT * FROM public.process_points",
            "SELECT * FROM public.events",
            "SELECT * FROM points.events",
            "SELECT * FROM history.process_points",
            "SELECT * FROM protocol_platform.history.events",
            "SELECT * FROM point_history",
            "SELECT count(*) FROM events FOR UPDATE",
            "SELECT * FROM sessions",
            "SELECT * FROM project_members",
            "SELECT * FROM protocol_platform.public.users",
            "SELECT * FROM public.users",
            "SELECT * FROM information_schema.tables",
            "SELECT * FROM pg_catalog.pg_authid",
            "WITH x AS (SELECT * FROM users) SELECT * FROM x",
            "SELECT (SELECT password_hash FROM users LIMIT 1)",
            "TABLE audit_logs",
            "WITH x AS (TABLE users) SELECT * FROM x",
            "SELECT id FROM process_points UNION TABLE project_members",
            "SELECT 1 OPERATOR(public.===) 1",
            "SELECT id INTO temporary_copy FROM process_points",
            "SELECT * FROM process_points FOR UPDATE",
            "SELECT * FROM process_points FOR SHARE",
            "SELECT dblink('other','SELECT * FROM users')",
        ] {
            assert!(check(sql).is_err(), "{sql}");
        }
    }
    #[test]
    fn accepts_project_analytics() {
        for sql in [
            "SELECT group_key,count(*) FROM process_points GROUP BY group_key",
            "WITH x AS (SELECT * FROM transmit_points) SELECT name FROM x",
            "SELECT name, row_number() OVER (ORDER BY display_order) FROM process_points",
            "SELECT before_data->>'name' FROM history.events WHERE kind='point' ORDER BY id DESC LIMIT 10",
            "SELECT kind,count(*) FROM events GROUP BY kind",
            "SELECT p.enum_name,t.address FROM points.process_points p JOIN points.transmit_points t ON p.id=t.process_point_id",
            "SELECT name FROM process_points UNION ALL SELECT name FROM transmit_points",
        ] {
            assert!(check(sql).is_ok(), "{sql}");
        }
    }
    #[test]
    fn cte_names_cannot_authorize_their_own_body_or_forward_references() {
        for sql in [
            "WITH project_state AS (SELECT * FROM project_state) SELECT * FROM project_state",
            "WITH previews AS (SELECT * FROM previews) SELECT * FROM previews",
            "WITH arbitrary_private_table AS (SELECT * FROM arbitrary_private_table) SELECT * FROM arbitrary_private_table",
            "WITH first AS (SELECT * FROM later), later AS (SELECT id FROM points.process_points) SELECT * FROM first",
            "WITH first AS (SELECT * FROM project_state), project_state AS (SELECT 1) SELECT * FROM first",
            "WITH process_points AS (SELECT * FROM meta.project_state) SELECT * FROM process_points",
            "WITH project_state AS (SELECT (SELECT topology_config FROM project_state)) SELECT * FROM project_state",
            "WITH project_state AS (SELECT 1) SELECT * FROM meta.project_state",
            "WITH \"history.events\" AS (SELECT * FROM \"history.events\") SELECT * FROM \"history.events\"",
            "WITH RECURSIVE x AS (SELECT 1 UNION ALL SELECT * FROM x) SELECT * FROM x",
        ] {
            assert!(check(sql).is_err(), "{sql}");
        }
    }
    #[test]
    fn nested_ctes_do_not_escape_their_query_scope() {
        for sql in [
            "WITH x AS (WITH project_state AS (SELECT id FROM points.process_points) SELECT * FROM project_state) SELECT * FROM project_state",
            "SELECT * FROM (WITH project_state AS (SELECT 1) SELECT * FROM project_state) x JOIN project_state p ON true",
            "WITH x AS (WITH secret AS (SELECT 1) SELECT * FROM secret), y AS (SELECT * FROM secret) SELECT * FROM y",
            "WITH \"safe\" AS (SELECT 1) SELECT * FROM \"SAFE\"",
            "WITH \"PROJECT_STATE\" AS (SELECT 1) SELECT * FROM project_state",
        ] {
            assert!(check(sql).is_err(), "{sql}");
        }
    }
    #[test]
    fn accepts_ordered_and_nested_nonrecursive_ctes() {
        for sql in [
            "WITH first AS (SELECT id FROM points.process_points), second AS (SELECT * FROM first) SELECT * FROM second",
            "WITH project_state AS (SELECT id FROM points.process_points) SELECT * FROM project_state",
            "WITH process_points AS (SELECT * FROM process_points) SELECT * FROM process_points",
            "WITH project_state AS (SELECT id FROM points.process_points), result AS (WITH project_state AS (SELECT * FROM project_state) SELECT * FROM project_state) SELECT * FROM result",
            "WITH x AS (WITH local_rows AS (SELECT * FROM points.process_points) SELECT * FROM local_rows) SELECT * FROM x",
            "WITH \"CaseSensitive\" AS (SELECT 1 AS value) SELECT * FROM \"CaseSensitive\"",
            "WITH MixedCase AS (SELECT 1 AS value) SELECT * FROM mixedcase",
            "WITH \"history.events\" AS (SELECT 1 AS value) SELECT * FROM \"history.events\"",
        ] {
            assert!(check(sql).is_ok(), "{sql}");
        }
    }
}

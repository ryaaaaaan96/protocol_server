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
    ast::{self, Expr, Query, SetExpr, Statement, TableFactor, Visit, Visitor},
    dialect::PostgreSqlDialect,
    parser::Parser,
};
use std::{collections::BTreeSet, ops::ControlFlow};

const RELATIONS: &[&str] = &[
    "board_models",
    "boards",
    "data_items",
    "signal_groups",
    "signals",
    "process_points",
    "transmit_points",
    "point_history",
    "signal_ranges",
    "device_contexts",
    "protocol_contracts",
    "protocol_fields",
    "endpoints",
    "signal_bindings",
    "board_links",
    "passthrough_routes",
    "platform_signals",
    "source_records",
    "v_signals",
    "v_protocol_fields",
    "v_bindings",
    "v_passthrough_fields",
    "v_topology_links",
];
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
    ctes: Vec<BTreeSet<String>>,
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
        let mut names = BTreeSet::new();
        if let Some(w) = &q.with {
            for c in &w.cte_tables {
                names.insert(c.alias.name.value.to_lowercase());
            }
        }
        self.ctes.push(names);
        if let SetExpr::Select(s) = q.body.as_ref() {
            if s.into.is_some() {
                return ControlFlow::Break("不允许 SELECT INTO".into());
            }
        }
        ControlFlow::Continue(())
    }
    fn post_visit_query(&mut self, _q: &Query) -> ControlFlow<String> {
        self.ctes.pop();
        ControlFlow::Continue(())
    }
    fn pre_visit_relation(&mut self, n: &ast::ObjectName) -> ControlFlow<String> {
        let name = n.to_string().to_lowercase();
        if !RELATIONS.contains(&name.as_str()) && !self.ctes.iter().any(|set| set.contains(&name)) {
            return ControlFlow::Break(format!(
                "不可访问对象 {name}，仅允许当前项目的业务表和视图"
            ));
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
    let mut g = Guard { ctes: Vec::new() };
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
    Json(
        json!({"sql":include_str!("../migrations/0005_topology.sql"),"relations":RELATIONS,"examples":[
        {"name":"板卡协议连接","sql":"SELECT client_board,server_board,protocol,transport,remote_address,context_code FROM v_topology_links ORDER BY id"},
        {"name":"内部信号与协议绑定","sql":"SELECT endpoint_name,context_code,resolved_sig_id,signal_name,protocol,effective_address,effective_length FROM v_bindings ORDER BY endpoint_id,context_id,effective_address"},
        {"name":"透传地址展开","sql":"SELECT route_name,name,upp_model,upp_offset,register_address,register_length FROM v_passthrough_fields ORDER BY route_id,register_address"},
        {"name":"信号范围和来源","sql":"SELECT group_name,name,resolved_sig_id,default_value,min_value,max_value,source_sheet,source_row FROM v_signals ORDER BY group_id,id"}
        ]}),
    )
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
    fn accepts_project_analytics() {
        for sql in [
            "SELECT group_id,count(*) FROM v_signals GROUP BY group_id",
            "WITH x AS (SELECT * FROM v_protocol_fields) SELECT name FROM x",
            "SELECT name, row_number() OVER (ORDER BY ordinal) FROM protocol_fields",
        ] {
            assert!(check(sql).is_ok(), "{sql}");
        }
    }
}

# Repository Guidelines

## Project Structure & Module Organization
Protocol Studio uses Rust, Vue 3, TypeScript, and PostgreSQL. Backend modules live in `src/`; Platform/project migrations and security policies live in `migrations/platform/` and `migrations/project/`; root migrations are legacy split inputs. Frontend pages, components, and domain helpers live under `frontend/src/`. Tests are in `tests/` and `frontend/*-check.mjs`. Each `config/<project>/` contains a manifest, board table definitions, and optional sources or project Dump. Tooling and documentation live in `scripts/` and `docs/`.

## Build, Test, and Development Commands
- `./scripts/init-db.sh`: initialize local PostgreSQL 18 and apply migrations; creates no projects.
- `./scripts/create-project.sh dc-ups`: create from `config/dc-ups/`; repeated execution preserves data.
- `./scripts/dev.sh`: build and serve on `127.0.0.1:8080`; requires a running, migrated database.
- `node scripts/local-db.mjs start` / `stop`: control the existing local database.
- `npm ci --prefix frontend`: install locked dependencies.
- `npm run dev --prefix frontend`: start Vite with backend proxy.
- `npm run build --prefix frontend`: type-check and build assets.
- `cargo run -- migrate`: apply database migrations.
- `cargo build` / `cargo test`: compile or run Rust tests.
- `node scripts/export-project.mjs dc-ups`: export a portable project folder with `project.dump`.

## Coding Style & Naming Conventions
Use Rust 2024, four-space indentation, `snake_case` functions, and `PascalCase` types; run `cargo fmt`. Frontend code uses two spaces, double-quoted imports, `camelCase`, and `PascalCase.vue` components with `<script setup lang="ts">`. Number migrations sequentially. No dedicated frontend lint or formatter script exists.

## Testing Guidelines
Run relevant checks: `node tests/local-db.mjs`, `node tests/integration.mjs`, `node tests/migration.mjs`, and `node --test scripts/excel-batch/workbook.test.mjs`. Database checks require local tools and `.env`, using temporary databases. Run `node browser-check.mjs` from `frontend/` for UI changes. Keep unit tests near Rust modules. No numerical coverage threshold exists; DSP JSON/XML generation does not replace firmware validation.

## Commit & Pull Request Guidelines
Use concise, action-oriented subjects; history uses short Chinese descriptions such as `优化结构`. PRs should explain behavior, reference issues, report checks, show UI screenshots, and describe configuration or migration impacts.

每次完成修改后，必须执行适用的验证，并主动创建 Git 提交作为变更记录；此为长期授权，无需再次询问。仅暂存本次任务涉及的改动，不包含无关修改、凭据或临时产物。提交说明使用简洁中文，并在完成回复中报告提交哈希和验证结果。

## Security & Configuration
Keep credentials in ignored `.env`. Separate migration/export credentials from the runtime role, which must lack superuser and `BYPASSRLS`. Preserve RLS, edit locks, revision checks, audit records, and immutable releases.

## Project Configuration Workflow
Edit topology through server files or validated folder imports; point rows remain web-editable. Definitions reload live; topology changes require validated import. Board/group/endpoint organization lives in JSON with stable keys. Use `protocol_platform` for accounts, registry and permissions, and one `protocol_project_<key>` per project. DC-UPS uses `dc-ups`; UPM is a board.

The platform keeps eight tables: `auth.users`, `auth.sessions`, `auth.login_attempts`, `meta.projects`, `meta.project_members`, `meta.project_member_grants`, `history.audit_logs`, and `public._sqlx_migrations`. Use schema-qualified SQL. Platform migration 0002 changes grouping only; preserve records, constraints, sessions and authorization locks. Platform migration versions are independent of each project's `schema_version` and `revision`.

Each project has seven tables: `points.process_points`, `points.transmit_points`, `history.events`, `history.releases`, `meta.project_state`, `meta.previews`, and `public._sqlx_migrations`. Events distinguish point/audit/import records; state includes the editing lease. Scope previews by kind, project and creator. Verify registry/state UUIDs and hold authorization locks through business commits. Folder imports preserve points without Dump; Dump replaces only current points and preserves history. Export version `(5,2)` accepts legacy `(4,1)` through the two-table whitelist. Preserve recovery journals and project isolation; use one server per configuration directory.

DSP internal data follows the `DSP内部数据` worksheet's 25 columns and has no sigID. Keep system IDs hidden for stable transmit references. Preserve original variable spelling, `Sys_` types and source cells; edit metadata through individual whitelisted fields. Derived worksheet values do not rewrite transmit mappings. Keep each board's table definitions and communication configuration independent.

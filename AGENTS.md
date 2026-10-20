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

Each project has eight tables: `points.process_points`, `points.collect_points`, `points.transmit_points`, `history.events`, `history.releases`, `meta.project_state`, `meta.previews`, and `public._sqlx_migrations`. Events distinguish point/audit/import records; state includes the editing lease. Scope previews by kind, project and creator. Verify registry/state UUIDs and hold authorization locks through business commits. Folder imports preserve points without Dump; Dump replaces only current points and preserves history. Export version `(6,3)` includes three point tables and accepts legacy `(4,1)` / `(5,2)` two-table archives with empty collection data. Preserve recovery journals and project isolation; use one server per configuration directory.

DSP internal data follows the `DSP内部数据` worksheet and has no sigID. Preserve its 25 source fields, with communication type and model hidden from the internal table. Keep system IDs hidden for stable transmit references. Preserve original variable spelling, `Sys_` types and source cells; edit metadata through individual whitelisted fields. Communication type is a suggestion, edited only per transmit mapping with override warnings and conversion validation. DSP UPP models are fixed by internal category and read-only in the transmit table; changing category updates every linked mapping atomically, with permissions, address checks, previews and history. DSP transmit names inherit the current internal name; every existing mapping participates in validation and generation, including legacy disabled rows. Do not expose independent DSP transmit name/enabled/conversion/byte_order inputs; derive conversion from internal and wire types and normalize the DSP byte-order compatibility value to 0. Retain shared storage fields for compatibility with other boards and Dumps. Keep UPM receiver settings independent from DSP. Show protocol byte count from wire_length. Never silently rewrite existing wire types or addresses. Keep each board's definitions and communication configuration independent.

DSP transmit `calculation` references one bounded JavaScript file per table via `script_file` in `transmit.json`. Resolve it within the board directory; use `export default function calculate(points, parameters)`. Only `id`, `address` and `wire_length` may be returned, for every existing mapping exactly once. Recalculate after a full single/batch change, before permission/validation/history checks; keep UI display order and previous computed values out of script inputs. Freeze both parameters and script contents in previews and reject changed scripts at commit. Configuration reads and imports without Dump never rewrite points. Require explicit reviewed recalculation when imported/stored layouts differ; block generation until synchronized. Keep manual wire types and scales independent; do not expose script-owned address/length editors. See `docs/table-calculation.md`.

UPM uses LOCAL and DSP templates with independent device instances in JSON. LOCAL has no collection mappings; eight DSP instances share one point definition and have separate dev_id/modbus_base values. Import UPM from its local/DSP/CSU worksheets, excluding CSU-local rows. Preserve missing sigIDs and source warnings; merge equal local enums only when internal definitions match, retaining multiple transmit mappings. UPP addresses count bytes; Modbus addresses count registers and add each device base. Use `import-upm <key>` only for additive first-time initialization; existing UPM data is preserved. See `docs/upm.md`.

# Repository Guidelines

## Project Structure & Module Organization
Protocol Studio uses Rust, Vue 3, TypeScript, and PostgreSQL. Backend modules live in `src/`; SQL migrations and security policies in `migrations/`. Frontend pages, components, and domain helpers live under `frontend/src/`. Tests are in `tests/` and `frontend/*-check.mjs`. Each `config/<project>/` contains a manifest, board table definitions, and optional sources or project Dump. Tooling and documentation live in `scripts/` and `docs/`.

## Build, Test, and Development Commands
- `./scripts/init-db.sh`: initialize local PostgreSQL 18 and apply migrations; creates no projects.
- `./scripts/create-project.sh upm`: create from `config/upm/`; repeated execution preserves data.
- `./scripts/dev.sh`: build and serve on `127.0.0.1:8080`; requires a running, migrated database.
- `node scripts/local-db.mjs start` / `stop`: control the existing local database.
- `npm ci --prefix frontend`: install locked dependencies.
- `npm run dev --prefix frontend`: start Vite with backend proxy.
- `npm run build --prefix frontend`: type-check and build assets.
- `cargo run -- migrate`: apply database migrations.
- `cargo build` / `cargo test`: compile or run Rust tests.
- `node scripts/export-project.mjs upm`: export a portable project folder with `project.dump`.

## Coding Style & Naming Conventions
Use Rust 2024, four-space indentation, `snake_case` functions, and `PascalCase` types; run `cargo fmt`. Frontend code uses two spaces, double-quoted imports, `camelCase`, and `PascalCase.vue` components with `<script setup lang="ts">`. Number migrations sequentially. No dedicated frontend lint or formatter script exists.

## Testing Guidelines
Run relevant checks: `node tests/local-db.mjs`, `node tests/integration.mjs`, `node tests/migration.mjs`, and `python3 tests/compile-generated.py`. Database checks require local tools and `.env`, using temporary databases. Run `node browser-check.mjs` from `frontend/` for UI changes. Keep unit tests near Rust modules. No numerical coverage threshold exists; generated-C checks do not replace firmware validation.

## Commit & Pull Request Guidelines
Use concise, action-oriented subjects; history uses short Chinese descriptions such as `优化结构`. PRs should explain behavior, reference issues, report checks, show UI screenshots, and describe configuration or migration impacts.

## Security & Configuration
Keep credentials in ignored `.env`. Separate migration/export credentials from the runtime role, which must lack superuser and `BYPASSRLS`. Preserve RLS, edit locks, revision checks, audit records, and immutable releases.

## Project Configuration Workflow
Edit topology through server files or validated folder imports; point rows remain web-editable. Definitions reload live, while database topology changes require import. Folder imports preserve points without Dump and replace project data with Dump. Keep project identity and applied topology snapshots in PostgreSQL. Maintain import recovery and project isolation; use one server per configuration directory.

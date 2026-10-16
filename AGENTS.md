# Repository Guidelines

## Project Structure & Module Organization
Protocol Studio manages industrial protocol configuration with Rust, Vue 3, TypeScript, and PostgreSQL. Backend modules in `src/` cover authentication, APIs, workbook import, validation, and code generation. `migrations/` contains numbered SQL migrations, views, grants, and row-level security policies. Frontend pages, reusable components, and domain helpers live in `frontend/src/pages/`, `components/`, and `domain/`. Integration and generated-C contract checks live in `tests/`; browser checks use `frontend/browser-check.mjs`. See `config/` for project JSON examples, `scripts/` for local tooling, and `docs/` for architecture and operations.

## Build, Test, and Development Commands
- `./scripts/init-db.sh`: explicitly initialize local PostgreSQL 18 and apply migrations (Linux x64); creates no business projects.
- `./scripts/create-project.sh upm`: explicitly create a project from `config/projects/upm/project.json`; repeated execution preserves saved data.
- `./scripts/dev.sh`: build and start the application on `127.0.0.1:8080`; requires an initialized, running database and does not run migrations.
- `node scripts/local-db.mjs start` / `stop`: control the existing local database without creating a new one.
- `npm ci --prefix frontend`: install locked frontend dependencies.
- `npm run dev --prefix frontend`: start Vite with `/api` proxied to the backend.
- `npm run build --prefix frontend`: type-check Vue/TypeScript and build frontend assets.
- `cargo run -- migrate`: apply database migrations using the configured migration account.
- `cargo run` / `cargo build`: run or compile the backend.
- `cargo test`: run Rust tests.

## Coding Style & Naming Conventions
Use Rust 2024 conventions: four-space indentation, `snake_case` functions/modules, and `PascalCase` types. Format Rust with `cargo fmt`. Follow existing frontend formatting: two-space indentation, double-quoted imports, `camelCase` identifiers, and `PascalCase.vue` components. Use Vue Composition API with `<script setup lang="ts">`. Name migrations sequentially, such as `0007_description.sql`. No dedicated frontend formatter or lint script is configured.

## Testing Guidelines
Run relevant checks before submitting: `node tests/local-db.mjs`, `node tests/integration.mjs`, `node tests/migration.mjs`, and `python3 tests/compile-generated.py`. Database integration checks require the local PostgreSQL tooling and `.env`; they create temporary databases. Keep Rust unit tests in module test blocks and standalone checks in descriptively named test scripts. No numerical coverage threshold is configured. For UI changes, run `node browser-check.mjs` from `frontend/` with the documented application/data prerequisites. Generated-C checks do not replace target firmware validation.

## Commit & Pull Request Guidelines
Existing commits use short Chinese descriptions, such as `优化结构`; no formal prefix convention is established. Use concise, action-oriented subjects. PRs should explain behavior changes, link relevant issues, report checks performed, and include screenshots for UI changes. Describe migration and configuration impacts explicitly.

## Security & Configuration
Keep credentials in ignored `.env` files. Separate `MIGRATION_DATABASE_URL` from the runtime `DATABASE_URL`; runtime roles must lack superuser and `BYPASSRLS` privileges. Preserve project isolation, preview/revision checks, audit records, and immutable releases when changing write paths.

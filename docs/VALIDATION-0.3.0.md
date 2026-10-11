# Проверка подготовки 0.3.0 — 11 октября 2026

Проверено на Windows x64, Node.js 24.21.0, Rust 1.98.1:

- Frontend regression tests: **235 passed**, 0 failed.
- Rust regression tests: **33 passed**, 0 failed. В том числе AES-256-GCM round trip, уникальные nonce, отказ при неверном ключе, повреждении и усечении ciphertext; SQLite atomicity и process lease.
- ESLint, TypeScript / Vite production build, `cargo clippy --locked --all-targets -- -D warnings`: passed.
- Windows EXE 0.3.0 и NSIS x64 installer: собраны успешно с `--locked` и платформенным конфигом.
- Три объединённых конфигурации Tauri проверены по schema установленного CLI 2.12.1. Workflow YAML разобран; проверена матрица Windows/macOS/Linux и read-only permissions.

Существующее предупреждение Vite о JS bundle более 500 kB остаётся (около 578 kB до gzip); сборку оно не блокирует.

macOS/Linux binaries не собирались и не запускались на этом Windows-ПК. Их компиляция, интеграция с реальным Keychain/Secret Service и UI smoke tests должны быть подтверждены CI и реальными ОС до публичного релиза. В unit tests для non-Windows хранения используется тестовый ключ; личный keyring не изменяется.

Исторический аудит Windows-версии 0.2.2 находится в `AUDIT-0.2.2.ru.md`; его результаты не являются проверкой новых macOS/Linux сборок.

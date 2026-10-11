# Reqmas

Локальный desktop API-клиент на React + TypeScript и Tauri 2. Коллекции, окружения, OAuth, Runner и просмотр ответов в оформлении хакерского терминала. Версия **0.3.0**, лицензия [MIT](LICENSE).

## Возможности

- HTTP-запросы с query parameters, headers, JSON/XML/raw/multipart/binary body.
- Коллекции и вложенные папки, вкладки, история, импорт Postman / OpenAPI / cURL.
- Окружения и переменные, Basic / Bearer / API key / OAuth 2.0 + PKCE.
- Response: подсветка, Pretty / Raw / Tree / Compare, поиск и сохранение исходных байтов.
- Runner, CSV/JSON datasets, assertions, извлечение переменных из ответов.
- Desktop: SQLite, автоматические резервные копии, proxy, собственные CA и mTLS.
- Dark / Light / System; локальные моноширинные шрифты.

Подробности и ограничения: [руководство пользователя](docs/USAGE.ru.md).

## Сборки

| ОС | Пакеты | Архитектура |
| --- | --- | --- |
| Windows | NSIS `.exe` | x64 |
| macOS | `.app`, `.dmg` | Intel и Apple Silicon; universal в CI |
| Linux Mint 21.x / 22.x | `.deb`, `.AppImage` | x64 |

В `.github/workflows/build.yml` настроены тесты и сборки на Windows, macOS 15 и Ubuntu 22.04. Более старая Linux-база выбрана для совместимости с Mint 21/22. Это целевые платформы: перед распространением пакетов нужны успешный CI и smoke-тесты на реальных ОС.

## Запуск

Нужны **Node.js 24**, npm, актуальный **Rust stable** и зависимости ОС из [BUILDING.md](BUILDING.md). Минимум для кода проекта — Rust 1.89; зависимости из lockfile могут требовать более новый stable.

```sh
npm ci --no-audit
npm run desktop:dev
```

Browser mode: `npm run dev`, адрес `http://localhost:58807`. Он использует localStorage и ограничения CORS; desktop выполняет HTTP через Rust.

Сборка пакетов на текущей ОС:

```sh
npm run desktop:build -- -- --locked
```

## Проверки

```sh
npm run lint
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Тесты шифрования macOS/Linux используют тестовый ключ и не обращаются к личному системному хранилищу.

## Хранение секретов

Windows использует DPAPI текущего пользователя. macOS/Linux шифруют известные credential-поля и Secret-переменные через AES-256-GCM с ключом в **macOS Keychain / Linux Secret Service**. В Linux нужен работающий, разблокированный keyring в desktop-сессии. При недоступном хранилище сохранение завершается ошибкой; plaintext fallback отсутствует.

Это защита известных секретных полей, а не полное шифрование workspace. Body, URL, datasets и произвольные поля могут содержать вручную введённые секреты. Браузерные данные и экспорт JSON не шифруются. Для переноса между ПК/ОС используйте Workspace → Backup → Include secrets и храните этот JSON безопасно. Копирования SQLite недостаточно: ключи остаются в исходной учётной записи ОС.

## GitHub и обновления

Репозиторий: [MirshaAndrey/ReqMas](https://github.com/MirshaAndrey/ReqMas). Первая загрузка и получение артефактов CI: [PUBLISHING.md](PUBLISHING.md).

CI использует стандартные runners и сохраняет пакеты в Actions artifacts, не создавая публичный Release. Хранение артефактов учитывается отдельно от бесплатных сборок публичного репозитория: [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions). При необходимости задайте бюджет $0 в настройках аккаунта.

Сборки без сертификата издателя не нотарифицированы Apple; для публичных macOS-релизов signing/notarization настраиваются отдельно. Встроенный updater: [UPDATES.md](UPDATES.md); адрес и ключ издателя по умолчанию пусты.

## Структура

- `src/` — интерфейс, модели и frontend transport.
- `src-tauri/src/` — HTTP, SQLite, защита секретов, OAuth callback и updater.
- `src-tauri/tauri.*.conf.json` — пакеты для каждой ОС.
- `tests/` — frontend-регрессии и синтетические fixtures.
- `.github/workflows/` — проверки и сборки трёх платформ.
- `docs/` — руководство и исторический аудит Windows-версии 0.2.2.

Зависимости, готовые бинарники, локальные базы и ключи не входят в исходники репозитория.

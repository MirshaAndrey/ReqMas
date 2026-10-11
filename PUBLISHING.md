# Загрузка в GitHub

Целевой репозиторий: https://github.com/MirshaAndrey/ReqMas. Копия подготовлена без `node_modules`, `dist`, Rust `target`, персональных баз и signing keys.

## Первая загрузка

В подготовленном каталоге настроен remote `origin`. Если Git identity ещё не задана, настройте её для своей учётной записи. Затем проверьте файлы и создайте initial commit:

```sh
git status --short
git add .
git diff --cached --stat
git commit -m "Prepare Reqmas for Windows, macOS and Linux builds"
git push -u origin main
```

Команды рассчитаны на пустой GitHub-репозиторий. Если там появились другие коммиты, сначала получите их и объедините историю. Для push нужна обычная авторизация GitHub (SSH / Git credential manager), токен в remote URL добавлять не нужно.

## Получить пакеты

После push откройте **Actions → Check and build Reqmas**. Запуск: main, pull requests, теги `v*` или вручную через **Run workflow**.

Артефакты успешной сборки:

- `reqmas-windows-x64`: NSIS installer.
- `reqmas-macos-universal`: DMG и архив `.app` для Intel/Apple Silicon.
- `reqmas-linux-x64`: DEB и AppImage.

Пакеты хранятся 3 дня в Actions artifacts. Для публичного Release загрузите проверенные пакеты отдельно. Workflow не требует PAT или signing keys. Стандартные runners бесплатны для публичного репозитория; хранение пакетов имеет отдельный лимит. Чтобы исключить платное превышение, задайте бюджет Actions $0 в настройках GitHub.

## Перед релизом

Согласованно меняйте версию в `package.json`, корневой записи `package-lock.json`, `src/version.ts`, `src-tauri/Cargo.toml`, записи reqmas в `src-tauri/Cargo.lock` и `src-tauri/tauri.conf.json`. Обновите CHANGELOG, выполните проверки и сборку. Node tests проверяют совпадение основных версий.

В Git не включайте JSON backups с credentials, `.env`, SQLite, приватные PEM/PFX/P12 и updater-ключи. MIT распространяется на код Reqmas; лицензии зависимостей сохраняются у их авторов.

# Подписанные обновления Reqmas

Обычный workflow GitHub собирает пакеты без updater-подписей и ничего не публикует. Приведённый ниже генератор manifest рассчитан только на Windows x64 NSIS. Для macOS используйте подписанный updater-архив `.app.tar.gz`, для Linux — подписанный AppImage и соответствующие записи платформ в manifest по документации Tauri. DEB не является пакетом встроенного updater. Сервер/ключи требуют отдельной настройки владельцем релизов.

В версии 0.2.0 готова проверка и установка подписанных обновлений через **App settings → Updates**. Сервер и ключ издателя пока не настроены. Пустые поля отключают проверку. Адрес и публичный ключ можно указать позже.

## Подготовить релиз

1. Перед новым релизом измените версию одновременно в `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` и `src/version.ts`. Ниже используется пример 0.3.0.
2. Один раз создайте ключ издателя в защищённой папке вне проекта. Команду выполняет владелец релизов; ключи в этом проекте не создавались:

   ```powershell
   npm run tauri -- signer generate --write-keys 'C:\secure\reqmas-updater.key'
   ```

   Сохраните приватный ключ и пароль отдельно от архива проекта. Для App settings нужен **текст** из файла `.pub`, а не путь к нему. Один и тот же публичный ключ применяется к последующим релизам.
3. Настройте переменные окружения в локальной сессии PowerShell или секретах CI. Значения ключа и пароля не помещайте в репозиторий или логи:

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY_PATH = 'C:\secure\reqmas-updater.key'
   # Для защищённого паролем ключа задайте TAURI_SIGNING_PRIVATE_KEY_PASSWORD через секреты CI.
   npm run desktop:build -- --config src-tauri/tauri.updater.conf.json
   ```

   Можно передать содержимое ключа через `TAURI_SIGNING_PRIVATE_KEY`; для `signer sign` эта переменная принимает именно содержимое. Файл `.env` не заменяет переменные окружения процесса сборки. Дополнительный конфиг включает `bundle.createUpdaterArtifacts: true`. Обычная сборка установщика не требует ключа. Параметры подтверждены локальным Tauri CLI 2.12.1 и [официальной документацией](https://v2.tauri.app/plugin/updater/#building).
4. Для стандартной сборки Windows x64 получите в `src-tauri/target/release/bundle/nsis/` пару `Reqmas_0.3.0_x64-setup.exe` и `Reqmas_0.3.0_x64-setup.exe.sig`. Если явно задан Rust target, файлы находятся под соответствующей папкой target. Сборка Tauri сама связывает подпись с версией приложения. При ручной подписи:

   ```powershell
   npm run tauri -- signer sign --private-key-path 'C:\secure\reqmas-updater.key' --app-version 0.3.0 'src-tauri\target\release\bundle\nsis\Reqmas_0.3.0_x64-setup.exe'
   ```

   Reqmas требует подписанную версию (`requireSignedVersion: true`). Не переименовывайте установщик после подписи: его имя тоже находится в подписанном комментарии. Синтаксис подтверждён локальным `signer sign --help` и [исходным кодом Tauri](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/helpers/updater_signature.rs).

## Подготовить manifest и размещение

Когда определён будущий HTTPS-адрес установщика, создайте JSON:

```powershell
node tools/create-update-manifest.mjs --artifact 'src-tauri\target\release\bundle\nsis\Reqmas_0.3.0_x64-setup.exe' --version 0.3.0 --url 'https://updates.example.com/Reqmas_0.3.0_x64-setup.exe' --output 'artifacts\latest-0.3.0.json'
```

Адрес `updates.example.com` — пример: замените его адресом своего хостинга. Дополнительно можно указать `--notes-file release-notes.txt` и `--date` в формате RFC 3339. Скрипт проверяет PE-файл, формат `.sig`, совпадение имени файла и подписанной версии. Он сохраняет подпись целиком и использует платформу `windows-x86_64`; существующий JSON не перезаписывает. Криптографическую проверку установщика выполняет updater при загрузке.

Разместите установщик и JSON на доступном HTTPS-хостинге: например, собственном сервере, статическом хранилище или в GitHub Releases. Затем укажите прямой URL JSON и текст публичного ключа в **App settings → Updates → Save update settings**. Для JSON удобен стабильный адрес `latest.json`; содержимое обновляется при публикации нового релиза. Файл `.sig` уже включён в manifest и отдельно клиенту не нужен. Никаких файлов этим скриптом в интернет не отправляется.

Статический endpoint возвращает JSON с `200 OK`; версия определяет доступность обновления. Динамический сервер может возвращать `204 No Content`, когда обновления нет. Формат manifest описан в [документации Tauri](https://v2.tauri.app/plugin/updater/#server-support).

Проверьте **Check for updates**, затем **Review installation**. Установка сохраняет workspace перед запуском установщика. Подпись updater защищает пакет обновления; подпись Windows Authenticode для первоначального установщика настраивается отдельно.

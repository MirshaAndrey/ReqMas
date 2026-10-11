# Сборка Reqmas

Пакеты собираются на ОС назначения: Windows на Windows, macOS на Mac, Linux на Linux. GitHub Actions позволяет получить все три из одного репозитория.

## Общие требования

Установите Node.js 24 и актуальный Rust stable через [rustup](https://rustup.rs/). В корне проекта:

```sh
npm ci --no-audit
rustup update stable
```

`package-lock.json` и `src-tauri/Cargo.lock` включены в Git. Для Cargo используйте `--locked`. Платформенные конфиги Tauri подхватываются автоматически: [официальная документация](https://v2.tauri.app/reference/config/#platform-specific-configuration).

## Windows x64

Нужны Microsoft C++ Build Tools с Desktop development with C++, Windows SDK и WebView2: [prerequisites Tauri](https://v2.tauri.app/start/prerequisites/#windows).

```powershell
rustup default stable-msvc
npm run desktop:build -- --target x86_64-pc-windows-msvc -- --locked
```

Результаты: `src-tauri/target/x86_64-pc-windows-msvc/release/reqmas.exe` и `release/bundle/nsis/*-setup.exe`. NSIS устанавливает приложение для текущего пользователя; bootstrapper WebView2 при необходимости скачивает runtime.

## macOS: Intel и Apple Silicon

Установите Xcode Command Line Tools: [prerequisites Tauri](https://v2.tauri.app/start/prerequisites/#macos).

```sh
xcode-select --install
npm run desktop:build -- -- --locked
```

Обычная команда собирает архитектуру текущего Mac. Результат: `src-tauri/target/release/bundle/macos/Reqmas.app` и `bundle/dmg/*.dmg`.

Universal-сборка для обеих архитектур:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run desktop:build -- --target universal-apple-darwin -- --locked
```

Результаты: `src-tauri/target/universal-apple-darwin/release/bundle/`. Этот вариант настроен в CI. Минимальная версия bundle — macOS 11.0; требуется smoke-проверка на выбранных версиях macOS.

Для переноса `.app` используйте DMG или ZIP с сохранением permissions и symlinks:

```sh
cd src-tauri/target/universal-apple-darwin/release/bundle/macos
ditto -c -k --sequesterRsrc --keepParent Reqmas.app Reqmas.app.zip
```

Для публичного распространения настройте Developer ID signing/notarization по [инструкции Tauri](https://v2.tauri.app/distribute/sign/macos/). Приватные ключи храните вне Git. Рабочие секреты используют login Keychain текущего пользователя.

## Linux Mint 21.x / 22.x, x64

CI использует Ubuntu 22.04 как более старую базу с WebKitGTK 4.1 для Mint 21/22: [Tauri AppImage](https://v2.tauri.app/distribute/appimage/). Mint 20.x и LMDE не входят в проверяемую матрицу.

Установите зависимости:

```sh
sudo apt update
sudo apt install build-essential curl wget file libwebkit2gtk-4.1-dev \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  libdbus-1-dev patchelf xdg-utils gnome-keyring
```

Для AppImage нужен FUSE 2 runtime: на Mint 21 — `sudo apt install libfuse2`, на Mint 22 — `sudo apt install libfuse2t64`. Затем:

```sh
npm ci --no-audit
npm run desktop:build -- --target x86_64-unknown-linux-gnu -- --locked
```

Зависимости Tauri: [официальный список](https://v2.tauri.app/start/prerequisites/#linux). Пакеты находятся в `src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/` и `bundle/appimage/`.

Установка DEB (имя замените фактическим):

```sh
sudo apt install ./Reqmas_0.3.0_amd64.deb
```

GitHub artifact ZIP теряет executable bit, поэтому для AppImage после извлечения:

```sh
chmod +x Reqmas_0.3.0_amd64.AppImage
./Reqmas_0.3.0_amd64.AppImage
```

Без FUSE можно запустить `./Reqmas_0.3.0_amd64.AppImage --appimage-extract-and-run`.

Для секретов нужна desktop-сессия с D-Bus и `org.freedesktop.secrets` (обычно GNOME Keyring). Разблокируйте login keyring через менеджер паролей системы и повторите сохранение. При ошибке keyring прежняя база сохраняется. Реализация: [keyring-rs](https://docs.rs/keyring/3.6.3/keyring/); plaintext fallback отсутствует.

## Перед распространением

Дождитесь успешных desktop jobs для всех ОС и job frontend. На реальной ОС проверьте запуск/закрытие, сохранение Secret-переменной и повторный запуск, запрос к тестовому API, OAuth PKCE, JSON backup/restore. Rust tests проверяют crypto и SQLite без личного keyring; они не заменяют этот smoke-тест.

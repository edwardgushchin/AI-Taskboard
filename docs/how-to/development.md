# Разрабатывать и проверять AI Taskboard

## Подготовка

Нужны Node.js 24.12 или новее, npm и Git 2.38 или новее.
В корне клона выполните:

```text
npm ci
npm run check
npm test
npm start
```

Для запуска CLI из исходников укажите корень нужной доски:

```text
npm run taskboard -- --project "C:/projects/example" --json list
```

Не используйте настоящую доску для тестовых фикстур. Создавайте отдельный временный каталог и удаляйте его после проверки.

## Документация

Проверьте локальные ссылки, якоря, точные пути исходников и npm scripts:

```text
npm run check:docs
```

Проверка охватывает Markdown репозитория, включая адаптированные правила.
Исторические отчёты проверяются на ссылки, но их прежние команды не сравниваются с текущим package.json.
Исходники в inline code проверяются для путей в src, scripts и build; созданные файлы и условные примеры требуют ручной проверки.
Проверка не доказывает соответствие всех описаний поведению: прочитайте изменённый код и выполните затронутый сценарий.

## Поставка

Для локальной сборки на целевой ОС запустите Node той же архитектуры и выполните:

```text
npm run package
```

Сборка CLI через `scripts/build-cli.mjs` создаёт автономный исполняемый файл с Node.js SEA.
`scripts/package.mjs` запускает electron-builder. Результаты находятся в `release/`.
Сборка CLI загружает лицензию точной версии Node.js; ошибка загрузки останавливает сборку.
Тексты лицензий собственного кода и сторонних компонентов поставляются вместе с приложением и CLI; условия описаны в [README](../../README.md#license-and-commercial-permission).
Встроенные правила документации распаковываются рядом с app.asar, чтобы агент мог читать их обычным файловым API.
Для Linux метаданные пакета задаются через AI_TASKBOARD_PROJECT_URL и AI_TASKBOARD_MAINTAINER.
Для распространения macOS нужны сертификаты Developer ID и нотарификация.

[Native CI](../../.github/workflows/ci.yml) выполняется для PR в `main` и push в `main`. Другой workflow может вызвать его через `workflow_call`. Он устанавливает нативный Node.js 24.14.0 из [дистрибутивов Node.js](https://nodejs.org/download/release/v24.14.0/) и проверяет совпадение ОС и архитектуры с матрицей.

| ОС | Архитектура | GitHub runner | Пакет CI |
| --- | --- | --- | --- |
| Windows | x64 | `windows-2025` | NSIS EXE |
| Windows | ARM64 | `windows-11-arm` | NSIS EXE |
| Linux | x64 | `ubuntu-24.04` | DEB и RPM |
| Linux | ARM64 | `ubuntu-24.04-arm` | DEB и RPM |
| macOS | Intel x64 | `macos-15-intel` | ZIP с APP |
| macOS | Apple Silicon ARM64 | `macos-15` | ZIP с APP |

Метки рассчитаны на [стандартные runner публичных репозиториев GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories). Статус каждого сочетания смотрите в [Native CI](https://github.com/edwardgushchin/AI-Taskboard/actions/workflows/ci.yml) для проверяемого коммита.

После `npm ci` команды профиля CI на Windows или macOS:

```text
npm run package -- --ci
node scripts/check-ci-package.mjs x64 ci-results
```

На ARM64 передайте `arm64`. Linux дополнительно использует RPM, библиотеки Electron и Xvfb. Запускайте проверку через `xvfb-run -a` с доступным Chromium sandbox. Точный список пакетов и настройка песочницы находятся в workflow.

Единый формат имени пакета и артефакта — `ai-taskboard-<version>-<os>-<arch>` с расширением формата у файла. Соседний артефакт `report-<os>-<arch>` содержит URL прогона, SHA исходников, сведения о среде, результаты проверки и SHA-256 пакетов. Проверка запуска использует распакованный Electron из того же процесса сборки и не выполняет установку в ОС.

Windows CI собирает неподписанный NSIS. macOS CI собирает ZIP с ad-hoc подписью для запуска на runner, без сертификатов распространения и нотарификации. Для публичной поставки macOS действует отдельный профиль PKG. CI не публикует GitHub Releases.

## Проверки интерфейса

Сценарии scripts/check-*.mjs используют Electron и локальные фикстуры. Например:

```text
node scripts/check-updates.mjs
```

Для видимых изменений сохраняйте только необходимые снимки. Остановите вспомогательные процессы и удалите созданные временные профили.

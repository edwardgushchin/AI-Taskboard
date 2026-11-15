# T-0084: изоляция досок и откат T-0082

Удалены только T-0014, T-0015 и T-0016 из `C:\Users\eduar\.tasks` штатной командой `recover-test-data`. Удалённые карточки содержали суммарно 360 тестовых токенов. `nextId=17`, настройки, история, manager usage и остальные прежние файлы сохранены. Рабочая база изменения: `174368fbc0de17fbbccd9b1ea4238d7e294acdbb`.

## Критерии и результаты

1. Причина: `locateBoard` принимал результат `discoverRepository(selected)` за разрешение инициализировать родительскую доску. Исходный CLI из корня доски воспроизвёл ошибку на отдельной системной TEMP-фикстуре: явный вложенный Temp/board и cwd рабочего worktree без GIT_CEILING_DIRECTORIES; результатом стал родительский Git-корень и `.tasks` в нём. Фикстура удалена в `finally`. Теперь тест публичного `init` возвращает канонический выбранный каталог; индекс родителя не меняется. Перед дальнейшими командами тест сверяет `project`.
2. Проверены самостоятельная вложенная доска, открытие из её подпапки, открытие родительской доски из обычной подпапки, основной и связанный Git worktree, подпапка связанного worktree, явный `git: true` и отказ для отсутствующего каталога. Два существующих сценария CLI также прошли.
3. Новый профиль `incident: T-0082` требует все три исходных файла с точными отпечатками. Старый профиль не принимает эти карточки с usage. На изолированных копиях прошли dry-run, применение, отказ при изменении индекса, изменении карточки (включая обновлённый манифест), неполном наборе, неверном корне, незаявленном pending, занятой блокировке старта, занятом start-gate, чужой ссылке и повторном применении. Существующие тесты восстановления проверили журнал до/после фиксации и гонку со стартом.
4. Реальный dry-run и применение вернули один набор карточек и одинаковые отпечатки до/после. После применения карточек нет; прежние файлы, кроме индекса и трёх выбранных карточек, побайтно совпадают. Уведомление `manager-chat/1794773031048-db5f81a9-af25-4110-978b-75a372324b27.json` об отмене T-0016 и `manager-status-position.json` сохранены как история инцидента. Другие сообщения не удалялись. Принадлежащих карточкам pending, attachments или worktrees не обнаружено.
5. `before.json` и `after.json` содержат полный перечень файлов и SHA-256. `dry-run.json` и `apply.json` фиксируют точный манифест. `docs/design.md` описывает выбор корня и новый профиль. Тесты автоматически удалили временные каталоги; отдельная проверка TEMP не обнаружила `T-0084-*`. Постоянный `.start-gate.sqlite` оставлен как объект синхронизации по дизайну.

## Проверки

- TypeScript: пройдено, код выхода 0.
- Целевые тесты: 4/4, код выхода 0; новый выбор корня, новый и прежний профили восстановления, гонка со стартом.
- Штатные сценарии CLI: 2/2, код выхода 0; вложенный Git init и общая доска связанных worktree.
- `git diff --check`: пройдено.
- Полный набор тестов не запускался. UI не менялся.

Первый запуск TypeScript выявил сужение `unknown` в новом коде; исправлено до успешной проверки. Первый запуск IPC-фикстуры остановился до записи из-за недоступного родительского Git в sandbox; добавлен потолок Git только этой изолированной фикстуре. Тест исходной маршрутизации работает без потолка. Реальный dry-run сначала получил `IO_ERROR: unable to open database file`; разрешённый запуск с расширенным доступом затем выполнил dry-run и применение.

## Технические детали

Среда: Windows, Node `v24.14.0`, Git `2.53.0.windows.2`. Команды выполнялись в назначенном worktree T-0084. Фикстуры JSON помечены `-text` в `.gitattributes`, чтобы checkout не менял доказанные байты.

```powershell
npm run check
node --disable-warning=ExperimentalWarning --test tests/board-location.test.ts tests/ipc-recovery.test.ts tests/test-recovery.test.ts
node --disable-warning=ExperimentalWarning --test --test-name-pattern='creating a board can initialize Git|linked worktrees share' tests/cli.test.ts
git diff --check
```

Реальные dry-run и применение (повторное применение должно отказать, поскольку карточки уже удалены):

```powershell
& 'C:\Program Files\nodejs\node.exe' --disable-warning=ExperimentalWarning src/cli/main.ts --project 'C:\Users\eduar' --json recover-test-data --input-file docs/verification/T-0084/dry-run.json
& 'C:\Program Files\nodejs\node.exe' --disable-warning=ExperimentalWarning src/cli/main.ts --project 'C:\Users\eduar' --json recover-test-data --input-file docs/verification/T-0084/apply.json
```

SHA-256 индекса до: `351f7c73ffc13ac4df80029d11d566bf7d784d414bc541dc081bccb5f9376416`.

SHA-256 индекса после: `f0ccbcdd2e831f645329eac899ce4e63f2c17d2e7dc1ee2d9dbcbc024ff64d9d`.

SHA-256 прежнего manager usage: `6d3307280ee4f21f9aac3f03036c3adf9862121f412152baecc9106aeef1b31a` (до и после).

SHA-256 `before.json`: `596b7b955109728bc2d462b2a92f0bc5ee5e462990590764e48f5cd7f977dfbd`.

SHA-256 `after.json`: `f987d17fc1794e8b04359b9502beb19bd5cafcbc9436dfdb9af1fd979122fed9`.

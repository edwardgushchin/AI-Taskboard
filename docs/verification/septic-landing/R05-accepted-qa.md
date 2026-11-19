# Браузерная проверка T-0003

Node v24.14.0; Playwright 1.56.1; Chromium 141.0.7390.37; chromiumSandbox:true.

Воспроизведение из корня checkout (PowerShell):

```powershell
$qaTools = Join-Path $env:TEMP 'septic-t0003-qa'
npm install --prefix $qaTools playwright@1.56.1 --ignore-scripts --no-audit --no-fund
node qa/check.cjs "$qaTools/node_modules/playwright"
git status --porcelain
```

- default: Q1–Q10, HTTP allowlist/methods, all 8 combinations, boundaries, nojs/startup, local storage/network PASS
- alternate: Q1–Q10, HTTP allowlist/methods, all 8 combinations, boundaries, nojs/startup, local storage/network PASS
- unequal: thresholds 2/5 m³; both services at threshold −0.1 / threshold / threshold +0.1, per-card amount and isFrom=false PASS
- restored: Q1–Q10, HTTP allowlist/methods, all 8 combinations, boundaries, nojs/startup, local storage/network PASS

Видимая обработка: 801.4–814.7 мс, 90 завершённых операций. Дубли submit/Enter не создали второго результата. Профиль заменялся в памяти createServer, файл исходного профиля не изменялся; последний прогон восстановил defaults. Для каждой из двух карточек услуги и цены проверены name, description, conditions, priceLabel, priceUnit, priceIncludes, сумма/валюта/isFrom по месту вывода. Проверено отсутствие старых фрагментов и возврат defaults. Дополнительный профиль unequal задаёт разные пороги 2/5 м³: сводки обеих выбранных услуг проверены ниже, на и выше соответствующего порога; для второй цены проверено isFrom:false. Изображения альтернативного профиля — переставленные два принятых локальных источника с другими alt/подписями.

Проверены размеры 1440×900, 390×844, 320×844; первый экран и полные страницы в hero/page PNG. Меню, FAQ, звонок, валидация, ожидание, отказ, успех, nojs и startup-failure приложены отдельно. Полные страницы снимаются с панелью действий в потоке, hero сохраняет реальную fixed-панель. Источники и представления указаны в source-sha256.txt.

Происхождение: design/assets/README.md; hero — принятая ИИ-иллюстрация, access — оригинальная SVG-схема. Исследование не обновлялось. Проверка не подтверждает оказание реальных услуг.

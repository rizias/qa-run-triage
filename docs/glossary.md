# Глоссарий

- **Allure report** — формат HTML/JSON-отчёта, который пишет раннер автотестов; инструмент
  читает его файлы из `runs/<джоба>/<билд>/report/allure-report/`.
- **Подпись ошибки (fingerprint)** — точный текст ошибки теста (`statusMessage` из Allure),
  используется как есть, без сокращений (`fingerprint: statusMessage` в `src/digest/failures.ts`).
- **`historyStatuses`** — статусы этого же теста в прошлых прогонах по данным истории Allure
  (`testCase.extra.history.items[].status` в `src/digest/failures.ts`).
- **`retriesCount`** — сколько раз Allure зафиксировал повторный запуск теста внутри одного
  прогона.
- **`freshness.isCurrent`** — при чтении исходника (`source`) — совпадает ли версия кода в
  закэшированном архиве прогона с той, что была во время прогона, или архив старее
  (`src/sources/artifactRead.ts`, `src/sources/workspaceFetch.ts`).
- **Состав прогона (test set)** — массив пар «полное имя теста, исход» для всех тестов
  прогона, хранится в `test-sets/<хэш>.json` (`writeTestSet` в `src/journal/runRefs.ts`).
- **Checkout** — пара «репозиторий, коммит», которую инструмент вытаскивает из строк
  консольного лога Jenkins вида `Cloning repository …` / `Checking out Revision …`
  (`src/fetcher/checkouts.ts`).
- **Аутентификация (`auth`)** — режим подключения сервера: `none` без заголовка
  `Authorization`, `basic` с парой `proxyUser:proxyPass` или `token` с парой `user:token`.
  Оба режима с учётными данными используют HTTP Basic; прокси необязателен.
- **`kind`** — тип сервера в `servers.<имя>.kind`; на сегодня реализован только один вид —
  `jenkins` (`SERVER_KINDS = ['jenkins']` в `src/configFields.ts`), другие виды CI не
  поддерживаются.
- **update-notifier** — библиотека npm (`update-notifier`), которой пользуется команда `qa-run-triage`
  (`src/skills/setup.ts`), чтобы не чаще раза в сутки в фоне проверять реестр npm на новую версию
  пакета.

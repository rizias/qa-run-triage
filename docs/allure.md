# Как считаются тесты

Allure хранит каждую повторную попытку отдельной записью с флагом `retry`. В основные числа
попадают только записи без `retry` и без `hidden`; их количество обязательно сверяется с
`statistic.total` из сводки Allure. Попытки с `retry` считаются отдельно в `retryAttempts`.

Тест со статусом `passed` и `retriesCount > 0` не считается падением, но отмечается как
восстановившийся после повтора в `recoveredAfterRetry`. Команда `failures --recovered`
показывает такие тесты отдельно.

У Playwright `testFile` берётся из `fullName` до `#`
или ` › ` (оба формата адаптера allure-playwright). Название и группы теста в путь не входят.
Эти форматы не содержат строку: `testLine=null`. Формат местоположения
`путь:строка:столбец` также читается с числовым `testLine`.
Источник: [официальный allure-playwright, getStaticTestMetadata](https://github.com/allure-framework/allure-js/blob/main/packages/allure-playwright/src/index.ts).

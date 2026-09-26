# Ступеньки English

Тренажёр английского A0–C2: адаптивный тест уровня, 11 игр с карточками, интервальные повторения по системе Лейтнера и озвучка всех слов и фраз.

**Сайт:** https://apollon-max.github.io/stupenki-english/

Статический сайт без сборки: `index.html` + `config.js` + `data.js` + `app.js` + `audio/`.

## Запуск

- **Локально:** `python3 -m http.server` в папке проекта, затем открыть http://localhost:8000. При открытии `index.html` как файла озвучка не загрузится.
- **GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / `(root)`.

## Облачное сохранение (Supabase)

1. Создать проект на supabase.com.
2. SQL Editor → выполнить [supabase/schema.sql](supabase/schema.sql) (файл можно запускать повторно — он же обновляет старую схему).
3. Вписать Project URL и publishable (anon) key в [config.js](config.js).

Без настройки сайт работает, прогресс хранится только в браузере.

## Контент и озвучка

Весь контент лежит в [data.js](data.js). После изменений нужно переозвучить (нужны macOS и ffmpeg):

```bash
node tools/build-audio.js
```

Подробности: [SPEC.md](SPEC.md).

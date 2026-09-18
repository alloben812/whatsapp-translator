# Голосовой ввод

Голосовой ввод остаётся локальной серверной расшифровкой перед обычным исходящим сценарием: владелец записывает сообщение в браузере, сервер распознаёт русскую речь в текст, владелец видит текст и только после явной команды отправляет перевод выбранному контакту. Распознавание не выбирает адресата, не отвечает собеседнику и не отправляет сообщение само.

## Контракт модуля

`src/transcription.ts` экспортирует `Transcriber`, `CommandTranscriber` и `createTranscriber`.

```ts
interface Transcriber {
  transcribe(bytes: Buffer, language: string): Promise<string>;
}
```

Язык строго ограничен кодами `ru` и `sr`; для первой UI-интеграции нужен `ru`. HTTP-слой принимает только явную загрузку аудио от владельца, проверять MIME и размер, передавать в модуль сырой `Buffer` и показывать результат как черновик текста. Запись в браузере требует пользовательского жеста через `MediaRecorder`; микрофон нельзя включать автоматически. Реалистичные форматы от браузеров: `audio/webm` с Opus в Chromium/Firefox и `audio/mp4` в Safari. Сам модуль не доверяет расширению или MIME: декодирование и ограничение длительности выполняет Python-скрипт.

## Серверная граница

Node.js запускает фиксированную команду Python с фиксированным `scripts/transcribe.py`, без shell и без передачи текста через аргументы. Аудио записывается во временный файл с правами `0600`, затем каталог удаляется в `finally`. По умолчанию:

- входной файл до 8 МБ;
- длительность после декодирования до 60 секунд;
- один активный процесс; в серверной конфигурации второй запрос получает ошибку занятости;
- серверный таймаут 70 секунд;
- stdout+stderr до 32 КБ;
- ответ строго UTF-8 JSON вида `{"text":"..."}`.

Ошибки нормализуются в `ServiceError` с кодами вроде `invalid_audio`, `transcription_busy`, `transcription_timeout`, `transcription_output_limit`, `invalid_transcription` и `transcription_unavailable`. Сырые stderr, пути сессий, токены и аудио не попадают в ответ.

## faster-whisper

Рекомендуемый старт для существующего Hetzner 2 vCPU / 4 ГБ: `faster-whisper` на CPU, `compute_type="int8"`, модель `small`, beam size 3, `cpu_threads=2`, VAD включён. На сервере доступно чуть больше 3 ГБ RAM, а официальный CPU benchmark для `small` int8 показывает порядок 1.5 ГБ RAM на 8 потоках, поэтому `small` разумно проверить первым ради русского. Если реальные короткие сообщения окажутся слишком медленными или начнут давить соседние службы, откатиться на `base` и измерить качество. Не обещать задержку без живого замера.

Установка выполняется отдельно от обновления приложения:

```sh
sudo bash /opt/whatsapp-translator/current/infra/install-speech.sh
```

Скрипт использует закреплённые версии из `infra/requirements-speech.txt` и модель `Systran/faster-whisper-small` revision `536b0662742c02347bc0e980a01041f333bce120`. Загружаются только четыре файла модели в `/opt/whatsapp-translator/models/faster-whisper-small`. Ключ Hugging Face и внешнее распознавание не используются. После установки запустить обычный `infra/install.sh` для выбранного release: он добавит параметры речи, сохранив существующие настройки.

Модель должна лежать в локальном каталоге CTranslate2 до запуска сервиса. В запросе загрузки нет: скрипт выставляет offline-переменные Hugging Face и вызывает `WhisperModel(..., local_files_only=True)`. По фактическому дереву `Systran/faster-whisper-small` health-check требует `model.bin`, `config.json`, `tokenizer.json` и `vocabulary.txt`; `preprocessor_config.json` в этом репозитории отсутствует и не требуется.

Пример конфигурации приложения:

```ts
const transcriber = new CommandTranscriber({
  command: '/opt/whatsapp-translator/stt-venv/bin/python',
  script: '/opt/whatsapp-translator/current/scripts/transcribe.py',
  modelDir: '/opt/whatsapp-translator/models/faster-whisper-small',
});
```

Сервер использует переменные `WA_STT_PYTHON` и `WA_STT_MODEL` из `/etc/whatsapp-translator/application.env`. Путь скрипта берётся из установленного release. Общий лимит памяти службы — 1900 МБ, CPU — 175% одного ядра; это включает приложение и дочерний распознаватель.

`POST /api/transcribe` принимает raw body с `Content-Type` `audio/webm`, `audio/mp4`, `audio/ogg` или `audio/wav` и обычным `x-csrf-token`. Язык владельца фиксирован: `ru`. Ответ: `{"text":"..."}`. `GET /api/state` показывает `speech: { "ready": boolean, "language": "ru", "maxSeconds": 60 }`. Аудио не сохраняется после завершения запроса; распознанный текст возвращается в черновик и автоматически не отправляется.

PyAV декодирует запись один раз с запретом сетевых протоколов и ограничением длительности; затем Whisper получает готовый PCM, а не имя загруженного файла. Контейнеры плейлистов не поддерживаются.

`CommandTranscriber.probe()` запускает `--check`: он проверяет локальный каталог модели и импорты `av`/`faster_whisper`, но не делает inference и не подтверждает скорость или качество будущей расшифровки.

## Источники

Официальный README faster-whisper описывает проект как реализацию Whisper на CTranslate2 и указывает, что 8-битная квантизация повышает эффективность на CPU и GPU. Он же показывает CPU `compute_type="int8"`, VAD через Silero и то, что PyAV включает FFmpeg-библиотеки, поэтому отдельный системный FFmpeg не обязателен: https://github.com/SYSTRAN/faster-whisper.

В коде `WhisperModel` есть `local_files_only`, `cpu_threads`, список размеров моделей и комментарий, что размер или Hub ID могут быть скачаны с Hugging Face Hub, поэтому для этого проекта используется только путь к локальному каталогу и offline-режим: https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py.

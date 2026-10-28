#!/bin/bash
# Харнесс-кит, PreToolUse для Write и Edit. Запрещает запись в файл состояния
# (STATE.json, state.json, features.json, test-results.json), пока в этой
# сессии не открыт ни один файл-доказательство (см. track-read.sh). После
# разрешённой записи журнал обнуляется: следующая пометка «пройдено» требует
# свежего доказательства. Учебный образец Anthropic, не граница безопасности:
# обходится через Bash. Защищает от невнимательности, не от злого умысла.
set -u

LOG="${VERIFY_READ_LOG:-}"
REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
[ -z "$LOG" ] && LOG="$REPO/.claude/.evidence-reads"
RESULTS_RE="${RESULTS_FILES_RE:-^(STATE\.json|state\.json|features\.json|test-results\.json)$}"

INPUT="$(cat 2>/dev/null || true)"
TARGET="$(printf '%s' "$INPUT" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))
except Exception: print('')" 2>/dev/null || true)"
[ -z "$TARGET" ] && exit 0

BASE="$(basename "$TARGET")"
if ! printf '%s' "$BASE" | grep -E -q "$RESULTS_RE"; then
  exit 0
fi

if [ ! -s "$LOG" ]; then
  python3 -c 'import json; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Файл состояния менять нельзя: в этой сессии не открыт ни один файл-доказательство (артефакт прогона, лог, скриншот, чекпоинт). Сначала прочитай доказательство инструментом Read, затем повтори запись. Правило: меняются только status и evidence, формулировки пунктов неизменяемы."}}, ensure_ascii=False))'
  exit 0
fi
: > "$LOG"
exit 0

#!/bin/bash
# Харнесс-кит, PreToolUse для Write и Edit. Запрещает запись в файл состояния
# (STATE.json, state.json, features.json, test-results.json), если за последние
# 30 минут в сессии не открыт ни один файл-доказательство (см. track-read.sh).
# Журнал обнуляется SessionStart-хуком на startup и clear, а не после каждой
# записи: правка одного state-файла несколькими Edit подряд проходит.
# Учебный образец Anthropic, не граница безопасности: обходится через Bash.
# Защищает от невнимательности, не от злого умысла.
set -u

INPUT="$(cat 2>/dev/null || true)"
META="$(printf '%s' "$INPUT" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin); print(d.get('cwd','')); print((d.get('tool_input') or {}).get('file_path',''))
except Exception:
    print(''); print('')" 2>/dev/null || printf '\n\n')"
CWD="$(printf '%s\n' "$META" | sed -n '1p')"
TARGET="$(printf '%s\n' "$META" | sed -n '2p')"
[ -n "$TARGET" ] || exit 0

RESULTS_RE="${RESULTS_FILES_RE:-^(STATE\.json|state\.json|features\.json|test-results\.json)$}"
BASE="$(basename "$TARGET")"
if ! printf '%s' "$BASE" | grep -E -q "$RESULTS_RE"; then
  exit 0
fi

REPO=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  REPO="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$REPO" ] || REPO="${CLAUDE_PROJECT_DIR:-}"
[ -n "$REPO" ] || REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LOG="${VERIFY_READ_LOG:-$REPO/.claude/.evidence-reads}"
WINDOW_MIN="${EVIDENCE_WINDOW_MIN:-30}"

fresh=""
if [ -s "$LOG" ]; then
  fresh="$(find "$LOG" -mmin "-${WINDOW_MIN}" 2>/dev/null || true)"
fi
if [ -z "$fresh" ]; then
  python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Файл состояния менять нельзя: за последние "+sys.argv[1]+" минут в этой сессии не открыт ни один файл-доказательство (артефакт прогона, лог, чекпоинт, скриншот, снимок). Сначала прочитай доказательство (Read или cat), затем повтори запись. Правило: меняются только status и evidence, формулировки пунктов неизменяемы."}}, ensure_ascii=False))' "$WINDOW_MIN"
  exit 0
fi
exit 0

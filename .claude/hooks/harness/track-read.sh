#!/bin/bash
# Харнесс-кит, PostToolUse для Read и Bash. Записывает факт чтения
# файла-доказательства (артефакт прогона, лог, чекпоинт, скриншот, снимок,
# отчёт) в журнал, который читает verify-gate.sh. Сам файл состояния
# (STATE.json, features.json, test-results.json) доказательством не считается:
# иначе штатная пара Read → Edit того же файла открывала бы гейт.
# Из Bash засчитываются только команды чтения (cat, head, tail, sed, less, jq,
# grep, awk, cut, wc, strings, xxd). Настройки через окружение или файлы:
#   EVIDENCE_RE            — что считать доказательством (регулярное выражение по пути);
#   EVIDENCE_EXCLUDE_RE    — что доказательством не считать, даже если путь подошёл
#                            (или файл .claude/harness-kit/evidence-exclude, одна строка);
#   VERIFY_READ_LOG        — путь к журналу (по умолчанию .claude/.evidence-reads).
set -u

INPUT="$(cat 2>/dev/null || true)"
META="$(printf '%s' "$INPUT" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin); ti=d.get('tool_input') or {}
    print(d.get('cwd','')); print(d.get('tool_name','')); print(ti.get('file_path','')); print((ti.get('command','') or '').replace('\n',' '))
except Exception:
    print(''); print(''); print(''); print('')" 2>/dev/null || printf '\n\n\n\n')"
CWD="$(printf '%s\n' "$META" | sed -n '1p')"
TOOL="$(printf '%s\n' "$META" | sed -n '2p')"
TARGET="$(printf '%s\n' "$META" | sed -n '3p')"
COMMAND="$(printf '%s\n' "$META" | sed -n '4p')"

REPO=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  REPO="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$REPO" ] || REPO="${CLAUDE_PROJECT_DIR:-}"
[ -n "$REPO" ] || REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LOG="${VERIFY_READ_LOG:-$REPO/.claude/.evidence-reads}"

EVIDENCE_RE="${EVIDENCE_RE:-(/evidence/|(^|/)evidence[^/]*$|/checkpoints?/|/проверка-|/отчёт|/отчет|/snapshots?/|/снимок|/журнал|/logs?/|/лог/|/логи/|\.log$|\.png$|\.jpg$|\.jpeg$|\.vtt$|/прогон|/results?/|/reports?/|/результат|/artifacts?/|verdict\.json$)}"
EXCLUDE_RE="${EVIDENCE_EXCLUDE_RE:-}"
if [ -z "$EXCLUDE_RE" ] && [ -f "$REPO/.claude/harness-kit/evidence-exclude" ]; then
  EXCLUDE_RE="$(grep -v '^#' "$REPO/.claude/harness-kit/evidence-exclude" | head -1 || true)"
fi

candidates=""
if [ "$TOOL" = "Bash" ]; then
  # только команды чтения; пути из них: токены, похожие на путь к файлу
  if printf '%s' "$COMMAND" | LC_ALL=C grep -E -q '(^|[[:space:]|;&(])(cat|head|tail|sed|less|more|jq|grep|rg|awk|cut|wc|bat|xxd|strings)([[:space:]]|$)'; then
    candidates="$(printf '%s\n' "$COMMAND" | tr ' ' '\n' | grep -E '/|\.(log|png|jpg|jpeg|vtt|json)$' || true)"
  fi
else
  candidates="$TARGET"
fi
[ -n "$candidates" ] || exit 0

RESULTS_RE="${RESULTS_FILES_RE:-^(STATE\.json|state\.json|features\.json|test-results\.json)$}"
while IFS= read -r c; do
  [ -n "$c" ] || continue
  # файл состояния не доказательство, где бы он ни лежал (results/STATE.json тоже)
  if printf '%s' "$(basename "$c")" | grep -E -q "$RESULTS_RE"; then continue; fi
  if [ -n "$EXCLUDE_RE" ] && printf '%s' "$c" | LC_ALL=C grep -E -q "$EXCLUDE_RE"; then continue; fi
  if printf '%s' "$c" | LC_ALL=C grep -E -q "$EVIDENCE_RE"; then
    mkdir -p "$(dirname "$LOG")"
    printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$c" >> "$LOG"
  fi
done <<< "$candidates"
exit 0

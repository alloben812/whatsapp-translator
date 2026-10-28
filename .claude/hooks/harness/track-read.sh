#!/bin/bash
# Харнесс-кит, PostToolUse для Read и Bash. Записывает факт чтения
# файла-доказательства (артефакт прогона, лог, чекпоинт, скриншот, снимок)
# в журнал, который читает verify-gate.sh. Страницы wiki/ и сырьё sources/
# доказательством не считаются. По образцу anthropics/cwc-long-running-agents.
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

EVIDENCE_RE="${EVIDENCE_RE:-(/evidence/|(^|/)evidence[^/]*$|/checkpoints/|/проверка-|/отчёт|/отчет|/snapshot/|/снимок|/журнал|/logs?/|/логи?/|\.log$|\.png$|\.jpg$|\.jpeg$|\.vtt$|/прогон|/results?/|/результат|test-results\.json$|STATE\.json$|state\.json$)}"

candidates=""
if [ "$TOOL" = "Bash" ]; then
  # пути из команды (cat, sed -n, head, jq ...): только токены, похожие на путь
  candidates="$(printf '%s\n' "$COMMAND" | tr ' ' '\n' | grep -E '/|\.(log|png|jpg|jpeg|vtt|json)$' || true)"
else
  candidates="$TARGET"
fi
[ -n "$candidates" ] || exit 0

hit=0
while IFS= read -r c; do
  [ -n "$c" ] || continue
  case "$c" in */wiki/*|wiki/*|*/sources/*|sources/*) continue ;; esac
  if printf '%s' "$c" | LC_ALL=C grep -E -q "$EVIDENCE_RE"; then
    mkdir -p "$(dirname "$LOG")"
    printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$c" >> "$LOG"
    hit=1
  fi
done <<< "$candidates"
exit 0

#!/bin/bash
# Харнесс-кит, PostToolUse для Read. Записывает факт чтения файла-доказательства
# (evidence) в журнал, который читает verify-gate.sh. По образцу
# anthropics/cwc-long-running-agents/hooks/track-read.sh, пути и шаблоны наши.
set -u

LOG="${VERIFY_READ_LOG:-}"
REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
[ -z "$LOG" ] && LOG="$REPO/.claude/.evidence-reads"

INPUT="$(cat 2>/dev/null || true)"
TARGET="$(printf '%s' "$INPUT" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))
except Exception: print('')" 2>/dev/null || true)"
[ -z "$TARGET" ] && exit 0

# Что считается доказательством: артефакт прогона или проверки, не исходник и не вики.
EVIDENCE_RE="${EVIDENCE_RE:-(/evidence/|/checkpoints/|/проверка-|/отчёт|/отчет|/snapshot/|/журнал|\.log$|\.png$|\.jpg$|\.jpeg$|\.vtt$|/прогон|/results?/|/результат)}"
if printf '%s' "$TARGET" | grep -E -q "$EVIDENCE_RE"; then
  mkdir -p "$(dirname "$LOG")"
  printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" >> "$LOG"
fi
exit 0

#!/bin/bash
# Харнесс-кит, Stop. Печатает владельцу число незакоммиченных файлов и
# незапушенных коммитов текущей ветки. В git ничего не пишет и ход не блокирует.
# Зачем: «вторая память» (git) полна, только если окно заканчивается коммитом.
# Авто-коммит и авто-push на Stop отклонены ревью Astra (РЕВЬЮ-РЕШЕНИЯ.md №8):
# они не учитывают ветку, незавершённые коммиты и чувствительные файлы.
set -u

INPUT="$(cat 2>/dev/null || true)"
if printf '%s' "$INPUT" | grep -q '"stop_hook_active": *true'; then
  exit 0
fi

REPO="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$REPO" ]; then
  REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
cd "$REPO" 2>/dev/null || exit 0

BRANCH="$(git branch --show-current 2>/dev/null || echo '?')"
DIRTY="$(git status --porcelain --untracked-files=normal 2>/dev/null | wc -l | tr -d ' ')"
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  AHEAD="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
else
  AHEAD="$(git rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)"
fi

if [ "${DIRTY:-0}" = "0" ] && [ "${AHEAD:-0}" = "0" ]; then
  exit 0
fi

MSG="Харнесс: ветка ${BRANCH}, незакоммиченных файлов ${DIRTY}, незапушенных коммитов ${AHEAD}. Если это конец окна: коммит, push, строка в HANDOFF."
python3 -c 'import json,sys; print(json.dumps({"systemMessage": sys.argv[1]}, ensure_ascii=False))' "$MSG"
exit 0

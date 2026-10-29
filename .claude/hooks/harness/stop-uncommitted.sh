#!/bin/bash
# Харнесс-кит, Stop. Печатает владельцу число незакоммиченных файлов и
# незапушенных коммитов текущей ветки. В git ничего не пишет и ход не блокирует.
# Зачем: «вторая память» (git) полна, только если окно заканчивается коммитом.
# Авто-коммит на Stop сознательно не делается: он не учитывает ветку,
# незавершённые правки и чувствительные файлы.
# В репозитории без remote незапушенные коммиты не считаются.
set -u

INPUT="$(cat 2>/dev/null || true)"
if printf '%s' "$INPUT" | grep -q '"stop_hook_active": *true'; then
  exit 0
fi
CWD="$(printf '%s' "$INPUT" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('cwd',''))
except Exception: print('')" 2>/dev/null || true)"
REPO=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  REPO="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$REPO" ] || REPO="${CLAUDE_PROJECT_DIR:-}"
[ -n "$REPO" ] || REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO" ] || exit 0
cd "$REPO" 2>/dev/null || exit 0

BRANCH="$(git branch --show-current 2>/dev/null || true)"
[ -n "$BRANCH" ] || BRANCH="detached@$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
DIRTY="$(git status --porcelain --untracked-files=all 2>/dev/null | wc -l | tr -d ' ')"
AHEAD=""
if [ -n "$(git remote 2>/dev/null)" ]; then
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    AHEAD="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
  else
    AHEAD="$(git rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)"
  fi
fi

if [ "${DIRTY:-0}" = "0" ] && [ "${AHEAD:-0}" = "0" ]; then
  exit 0
fi

if [ -n "$AHEAD" ]; then
  MSG="Харнесс: ветка ${BRANCH}, незакоммиченных файлов ${DIRTY}, незапушенных коммитов ${AHEAD}. Если это конец окна: коммит, push, строка в HANDOFF."
else
  MSG="Харнесс: ветка ${BRANCH}, незакоммиченных файлов ${DIRTY} (remote не настроен). Если это конец окна: коммит, строка в HANDOFF."
fi
python3 -c 'import json,sys; print(json.dumps({"systemMessage": sys.argv[1]}, ensure_ascii=False))' "$MSG"
exit 0

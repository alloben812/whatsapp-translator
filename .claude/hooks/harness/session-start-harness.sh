#!/bin/bash
# Харнесс-кит, SessionStart. Только чтение, никогда не блокирует старт.
# Печатает: ветку и незакоммиченное, стопки «читать первым» в HANDOFF и
# стартовых промптах, напоминание про контракт и бюджет прогона.
# Зачем: формат хэндоффа без принудителя отрастает обратно (TMMi: семь
# «актуальных точек» за четыре недели после консолидации). Хук делает стопку
# видимой на каждом старте, пока она не свёрнута.
set -u

INPUT="$(cat 2>/dev/null || true)"
META="$(printf '%s' "$INPUT" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin); print(d.get('source','')); print(d.get('cwd',''))
except Exception:
    print(''); print('')" 2>/dev/null || printf '\n\n')"
SOURCE="$(printf '%s\n' "$META" | sed -n '1p')"
CWD="$(printf '%s\n' "$META" | sed -n '2p')"
if [ "$SOURCE" = "compact" ]; then
  exit 0
fi

# Корень репозитория: cwd из события (верно и для worktree), затем CLAUDE_PROJECT_DIR, затем git.
REPO=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  REPO="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$REPO" ] || REPO="${CLAUDE_PROJECT_DIR:-}"
[ -n "$REPO" ] || REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO" 2>/dev/null || exit 0

# Журнал доказательств verify-gate живёт одну сессию: на startup и clear обнуляем.
if [ "$SOURCE" = "startup" ] || [ "$SOURCE" = "clear" ]; then
  [ -d .claude ] && : > .claude/.evidence-reads 2>/dev/null || true
fi

BRANCH="$(git branch --show-current 2>/dev/null || true)"
[ -n "$BRANCH" ] || BRANCH="detached@$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
HOUR="$(date +%H)"

echo "=== 🔧 ХАРНЕСС: состояние окна ==="
echo "Ветка: ${BRANCH} · незакоммиченных файлов: ${DIRTY:-0} · локальное время: $(date '+%H:%M')"
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "Правило: правки только в отдельной ветке и через PR. Создай ветку до первой правки."
fi
if [ "${HOUR#0}" -ge 20 ] 2>/dev/null || [ "${HOUR#0}" -lt 7 ] 2>/dev/null; then
  echo "Бюджет: после 20:00 прогоны дольше 20 минут только после вопроса владельцу про квоту."
fi

# Стопки указателей: больше одного заголовка «читать первым / актуальная точка»
# в одном HANDOFF или стартовом промпте. Локаль C: без диапазонов кириллицы,
# та же форма, что в scripts/lint/lint.py (STACK_HEADER_RE).
STACK_RE='читать первым|Читать первым|ЧИТАТЬ ПЕРВЫМ|читай первым|(^|[ #*_])(Актуальн|актуальн)[^ ]* (контрольн[^ ]* )?точка|Текущая точка|ТЕКУЩАЯ ТОЧКА|Сначала прочитай|СНАЧАЛА ПРОЧИТАЙ'
found=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  n="$(LC_ALL=C grep -E -c "^#+.*(${STACK_RE})" "$f" 2>/dev/null || true)"
  n="${n:-0}"
  if [ "$n" -ge 2 ] 2>/dev/null; then
    found=1
    echo "Стопка указателей: $f · $n заголовков. Сверни верх в четыре блока (Сейчас / Сделано, не повторять / Дальше / Решения владельца), историю в HANDOFF-история.md."
  fi
done < <(git -c core.quotepath=false ls-files -- '*HANDOFF.md' '.claude/commands/*.md' 2>/dev/null)
if [ "$found" -eq 0 ]; then
  echo "Стопок «читать первым» в HANDOFF и стартовых промптах нет."
fi

echo "Контракт: до первого действия проверь в стартовом промпте пять строк (Результат / Не делаем / Готово когда / Останавливаюсь если / Кто принимает) и строку «Бюджет». Если их нет, допиши по .claude/harness-kit/templates/СТАРТ-шаблон.md и спроси владельца, верно ли."
echo "Конец хода текстом при открытых пунктах не считается завершением: если пункты контракта открыты и ничто не требует решения владельца, делай следующий шаг."
exit 0

#!/bin/bash
# Харнесс-кит, SessionStart. Только чтение, никогда не блокирует старт.
# Печатает: ветку и незакоммиченное, стопки «читать первым» в HANDOFF и
# стартовых промптах, напоминание про контракт и бюджет прогона.
# Зачем: формат хэндоффа без принудителя разъезжается (несколько заголовков
# «читать первым» в одном файле). Хук делает стопку видимой на каждом старте.
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

# Журнал доказательств verify-gate живёт одну сессию: на startup и clear обнуляем
# (только если гейт установлен или журнал уже есть; иначе файл не создаём).
if [ "$SOURCE" = "startup" ] || [ "$SOURCE" = "clear" ]; then
  if [ -f .claude/hooks/harness/verify-gate.sh ] || [ -f .claude/.evidence-reads ]; then
    : > .claude/.evidence-reads 2>/dev/null || true
  fi
fi

BRANCH="$(git branch --show-current 2>/dev/null || true)"
[ -n "$BRANCH" ] || BRANCH="detached@$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
DIRTY="$(git status --porcelain --untracked-files=all 2>/dev/null | wc -l | tr -d ' ')"
HOUR="$(date +%H)"

# Основные ветки (через запятую): HARNESS_BASE_BRANCH, файл base-branch, origin/HEAD, иначе main и master.
BASE="${HARNESS_BASE_BRANCH:-}"
[ -n "$BASE" ] || { [ -f .claude/harness-kit/base-branch ] && BASE="$(head -1 .claude/harness-kit/base-branch | tr -d ' \r')"; } || true
[ -n "$BASE" ] || BASE="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
[ -n "$BASE" ] || BASE="main,master"
on_base=0
case ",$BASE," in *",$BRANCH,"*) on_base=1 ;; esac

echo "=== 🔧 ХАРНЕСС: состояние окна ==="
echo "Ветка: ${BRANCH} · незакоммиченных файлов: ${DIRTY:-0} · локальное время: $(date '+%H:%M')"
if [ "$on_base" -eq 1 ] && [ -f .claude/hooks/harness/merge-guard.sh ]; then
  echo "Правило: правки только в отдельной ветке и через PR. Создай ветку до первой правки."
fi
# Правило вечернего бюджета включается флагом --night-rule (маркер night-rule); действует с 20:00 до 07:00.
if [ -f .claude/harness-kit/night-rule ] && { [ "${HOUR#0}" -ge 20 ] 2>/dev/null || [ "${HOUR#0}" -lt 7 ] 2>/dev/null; }; then
  echo "Бюджет: с 20:00 до 07:00 прогоны дольше 20 минут только после вопроса владельцу про квоту."
fi

# Стопки указателей: больше одного заголовка «читать первым / актуальная точка»
# в одном HANDOFF или стартовом промпте. Локаль C: без диапазонов кириллицы.
STACK_RE='читать первым|Читать первым|ЧИТАТЬ ПЕРВЫМ|читай первым|(^|[ #*_])(Актуальн|актуальн)[^ ]* (контрольн[^ ]* )?точка|Текущая точка|ТЕКУЩАЯ ТОЧКА|Сначала прочитай|СНАЧАЛА ПРОЧИТАЙ|read first|Read first|READ FIRST'
found=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  n="$(LC_ALL=C grep -E -c "^#+.*(${STACK_RE})" "$f" 2>/dev/null || true)"
  n="${n:-0}"
  if [ "$n" -ge 2 ] 2>/dev/null; then
    found=1
    echo "Стопка указателей: $f · $n заголовков. Сверни верх в четыре блока (Сейчас / Сделано, не повторять / Дальше / Решения владельца), историю в файл истории, принятый в репозитории (по умолчанию HANDOFF-история.md)."
  fi
done < <( { git -c core.quotepath=false ls-files -- '*HANDOFF.md' '.claude/commands/*.md' 2>/dev/null; [ -f .claude/harness-kit/entry-files ] && grep -v '^#' .claude/harness-kit/entry-files; } | sort -u)
if [ "$found" -eq 0 ]; then
  echo "Стопок «читать первым» в HANDOFF и стартовых промптах нет."
fi

echo "Контракт: до первого действия проверь в стартовом промпте пять строк (Результат / Не делаем / Готово когда / Останавливаюсь если / Кто принимает) и строку «Бюджет». Если их нет, допиши по .claude/harness-kit/templates/СТАРТ-шаблон.md и спроси владельца, верно ли."
echo "Конец хода текстом при открытых пунктах не считается завершением: если пункты контракта открыты, ничто не ждёт решения владельца и следующий шаг не тяжёлая работа, делай его в этом же ходе."
exit 0

#!/bin/bash
# Харнесс-кит, PreToolUse для Bash. Команды влития и переписывания истории
# переводятся в режим «спросить владельца»: gh pr merge, git merge <ветка>
# (кроме подтягивания main в рабочую ветку), git push в main/master (включая
# HEAD:main и +refspec), git push --force, git push без аргументов из main.
# Это Протокол влития из CLAUDE.md, закреплённый кодом. Команда разбирается
# по сегментам (&&, ||, ;, |, перенос строки), проверяются только сегменты,
# начинающиеся с git или gh: grep и echo со словами «merge» не трогаются.
set -u

INPUT="$(cat 2>/dev/null || true)"
python3 - "$INPUT" <<'PY'
import json, re, subprocess, sys
try:
    data = json.loads(sys.argv[1] or "{}")
except Exception:
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command") or ""
cwd = data.get("cwd") or None
if not cmd:
    sys.exit(0)

segs = [s.strip() for s in re.split(r"\n|&&|\|\||;|\|", cmd)]
segs = [s for s in segs if re.match(r"^\s*(?:\w+=\S+\s+)*(git|gh)\b", s)]
if not segs:
    sys.exit(0)

def current_branch():
    try:
        return subprocess.run(["git", "branch", "--show-current"], capture_output=True, text=True,
                              cwd=cwd, timeout=3).stdout.strip()
    except Exception:
        return ""

reasons = []
for seg in segs:
    if re.search(r"\bgh\s+pr\s+merge\b", seg) or re.search(r"\bgh\s+api\b.*/merge\b", seg):
        reasons.append("влитие PR")
    if re.search(r"\bgit\s+push\b.*\s(--force|-f|--force-with-lease)(\s|$)", seg):
        reasons.append("force-push")
    if re.search(r"\bgit\s+push\b.*\s\+\S", seg):
        reasons.append("force-push (+refspec)")
    if re.search(r"\bgit\s+push\b.*[\s:](main|master)(\s|$)", seg):
        reasons.append("push в main/master")
    if re.fullmatch(r"\s*(?:\w+=\S+\s+)*git\s+push(\s+-{1,2}[\w-]+)*\s*", seg) and current_branch() in ("main", "master"):
        reasons.append("push из main/master")
    for m in re.finditer(r"\bgit\s+merge\s+((?:-\S+\s+)*)(\S+)", seg):
        target = m.group(2).strip("'\"`")
        if target in ("main", "master", "origin/main", "origin/master") or target.startswith("-"):
            continue
        reasons.append(f"git merge {target}")

if not reasons:
    sys.exit(0)
out = {
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": (
            "Протокол влития: " + ", ".join(dict.fromkeys(reasons))
            + " только по явному ОК владельца на этот PR и этот head, после отчёта «что менялось, что не трогал, риски»."
        ),
    }
}
print(json.dumps(out, ensure_ascii=False))
PY
exit 0

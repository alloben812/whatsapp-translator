#!/bin/bash
# Харнесс-кит, PreToolUse для Bash. Команды влития и переписывания истории
# переводятся в режим «спросить владельца»: gh pr merge, git merge <ветка>
# (кроме подтягивания main в рабочую ветку), git push в main/master,
# git push --force. Это Протокол влития из CLAUDE.md, закреплённый кодом.
set -u

INPUT="$(cat 2>/dev/null || true)"
python3 - "$INPUT" <<'PY'
import json, re, sys
try:
    data = json.loads(sys.argv[1] or "{}")
except Exception:
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command") or ""
if not cmd:
    sys.exit(0)

reasons = []
if re.search(r"\bgh\s+pr\s+merge\b", cmd) or re.search(r"\bgh\s+api\b.*\/merge\b", cmd):
    reasons.append("влитие PR")
if re.search(r"\bgit\s+push\b[^|&;]*\s(--force|-f|--force-with-lease)\b", cmd):
    reasons.append("force-push")
if re.search(r"\bgit\s+push\b[^|&;]*\s(origin\s+)?(main|master)(\s|$|:)", cmd):
    reasons.append("push в main/master")
for m in re.finditer(r"\bgit\s+merge\s+([^\s|&;]+)", cmd):
    target = m.group(1)
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
            "Протокол влития: " + ", ".join(reasons)
            + " только по явному ОК владельца на этот PR и этот head, после отчёта «что менялось, что не трогал, риски»."
        ),
    }
}
print(json.dumps(out, ensure_ascii=False))
PY
exit 0

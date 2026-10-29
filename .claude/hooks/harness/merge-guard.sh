#!/bin/bash
# Харнесс-кит, PreToolUse для Bash. Команды влития и переписывания истории
# переводятся в режим «спросить владельца»: gh pr merge, git merge <ветка>
# (кроме подтягивания основной ветки в рабочую), git push в основную ветку
# (включая HEAD:<ветка> и +refspec), git push --force, git push без аргументов
# из основной ветки. Это протокол влития «только по явному ОК», закреплённый кодом.
# Команда разбирается по сегментам (&&, ||, ;, |, перенос строки), проверяются
# только сегменты, начинающиеся с git или gh: grep и echo со словом «merge» не трогаются.
# Основная ветка: переменная HARNESS_BASE_BRANCH, затем файл
# .claude/harness-kit/base-branch, затем origin/HEAD, затем main и master.
# Несколько основных веток перечисляются через запятую (develop,main).
set -u

INPUT="$(cat 2>/dev/null || true)"
python3 - "$INPUT" <<'PY'
import json, os, re, shlex, subprocess, sys
try:
    data = json.loads(sys.argv[1] or "{}")
except Exception:
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command") or ""
cwd = data.get("cwd") or None
if not cmd:
    sys.exit(0)

def git(*a):
    try:
        return subprocess.run(["git", *a], capture_output=True, text=True, cwd=cwd, timeout=3).stdout.strip()
    except Exception:
        return ""

def base_branches():
    b = os.environ.get("HARNESS_BASE_BRANCH", "").strip()
    if not b:
        root = git("rev-parse", "--show-toplevel") or os.environ.get("CLAUDE_PROJECT_DIR", "")
        p = os.path.join(root, ".claude", "harness-kit", "base-branch") if root else ""
        if p and os.path.exists(p):
            try:
                b = open(p, encoding="utf-8").read().strip().splitlines()[0].strip()
            except Exception:
                b = ""
    if not b:
        head = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")
        if head.startswith("origin/"):
            b = head[len("origin/"):]
    names = {x.strip() for x in b.split(",") if x.strip()} if b else {"main", "master"}
    return names

BASES = base_branches()
segs = [s.strip() for s in re.split(r"\n|&&|\|\||;|\|", cmd)]
segs = [s for s in segs if re.match(r"^\s*(?:\w+=\S+\s+)*(git|gh)\b", s)]
# глобальные опции git (-C <путь>, -c <ключ=значение>) между git и подкомандой
segs = [re.sub(r"\bgit(\s+(-C|-c)\s+\S+)+\s+", "git ", s) for s in segs]
if not segs:
    sys.exit(0)

def current_branch():
    return git("branch", "--show-current")

def merge_target(seg):
    try:
        toks = shlex.split(seg)
    except ValueError:
        toks = seg.split()
    try:
        i = toks.index("merge")
    except ValueError:
        return None
    skip_value = {"-m", "--message", "-s", "--strategy", "-X", "--strategy-option", "-F", "--file", "--into-name", "--gpg-sign", "-S"}
    j = i + 1
    while j < len(toks):
        t = toks[j]
        if t in skip_value:
            j += 2; continue
        if t.startswith("-"):
            j += 1; continue
        return t
    return None

base_alt = "|".join(re.escape(b) for b in sorted(BASES))
reasons = []
for seg in segs:
    if re.search(r"\bgh\s+pr\s+merge\b", seg) or re.search(r"\bgh\s+api\b.*/merge\b", seg):
        reasons.append("влитие PR")
    if re.search(r"\bgit\s+push\b.*\s(--force|-f|--force-with-lease(=\S+)?)(\s|$)", seg):
        reasons.append("force-push")
    if re.search(r"\bgit\s+push\b.*\s\+\S", seg):
        reasons.append("force-push (+refspec)")
    if re.search(r"\bgit\s+push\b", seg):
        try:
            toks = shlex.split(seg)
        except ValueError:
            toks = seg.split()
        args = [t for t in toks[toks.index("push") + 1:] if not t.startswith("-")] if "push" in toks else []
        refspecs = args[1:]
        dests = []
        for r in refspecs:
            dst = r.split(":", 1)[1] if ":" in r else r
            dst = re.sub(r"^\+", "", dst)
            dst = re.sub(r"^refs/heads/", "", dst)
            dests.append(dst)
        cur = None
        if (not refspecs) or any(d == "HEAD" for d in dests):
            cur = current_branch()
        if any(d in BASES for d in dests):
            reasons.append("push в основную ветку (" + ", ".join(sorted(BASES)) + ")")
        elif cur in BASES:
            reasons.append("push текущей основной ветки " + cur)
    if re.search(r"\bgit\s+merge\b", seg):
        target = merge_target(seg)
        if target:
            t = target.strip("'\"`")
            if t in BASES or any(t == "origin/" + b for b in BASES) or t.startswith("-"):
                continue
            reasons.append(f"git merge {t}")

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

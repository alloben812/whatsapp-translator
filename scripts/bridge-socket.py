#!/usr/bin/env python3
"""One systemd socket activation. Exposes only translation/check, never a shell."""
import json
from pathlib import Path
import subprocess
import sys

try:
    raw = sys.stdin.buffer.read(20001)
    if len(raw) > 20000:
        raise ValueError()
    request = json.loads(raw)
    command = ['/usr/bin/python3', '-I', str(Path(__file__).resolve().with_name('subscription-bridge.py'))]
    if request == {'operation': 'check'}:
        command.append('--check')
        payload = b''
        timeout = 8
    elif isinstance(request, dict) and set(request) == {'operation', 'input'} and request['operation'] == 'translate':
        payload = json.dumps(request['input'], ensure_ascii=False).encode()
        timeout = 70
    else:
        raise ValueError()
    # The inner broker owns bounded worker cancellation and redacted JSON output.
    result = subprocess.run(command, input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=timeout, check=False, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    if len(result.stdout) > 65536:
        raise ValueError()
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError()
    sys.stdout.write(json.dumps(value, ensure_ascii=False))
except Exception:
    sys.stdout.write('{"error":"translation_unavailable"}')
    sys.exit(1)

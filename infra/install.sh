#!/usr/bin/env bash
# Install only this application's units from an already uploaded immutable release.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) == 0 && $# == 1 && $1 =~ ^[a-f0-9]{40}$ ]] || exit 1
release=/opt/whatsapp-translator/releases/$1
[[ -d $release && ! -L $release ]] || exit 1
for directory in /opt /opt/whatsapp-translator /opt/whatsapp-translator/releases "$release"; do
  [[ -d $directory && ! -L $directory && $(stat -c %u "$directory") == 0 ]] || exit 1
  mode=$(stat -c %a "$directory"); (( (8#$mode & 8#022) == 0 )) || exit 1
done
[[ -f $release/dist/src/server.js && -d $release/node_modules && -f $release/web/index.html ]] || exit 1
if ! id whatsapp-translator >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/whatsapp-translator --shell /usr/sbin/nologin whatsapp-translator
fi
install -d -o root -g root -m 0700 /etc/whatsapp-translator
install -d -o whatsapp-translator -g whatsapp-translator -m 0700 /var/lib/whatsapp-translator
# Administrative SSH only; model runtime users do not join this group.
usermod -a -G whatsapp-translator mma
if [[ ! -e /etc/whatsapp-translator/translator.json ]]; then
  (umask 077; cat > /etc/whatsapp-translator/translator.json <<'JSON'
{"provider":"claude","model":"sonnet","budgetMode":"subscription_limits","serbianScript":"latin"}
JSON
  )
fi
if [[ ! -e /etc/whatsapp-translator/application.env ]]; then
  (umask 077; cat > /etc/whatsapp-translator/application.env <<'ENV'
WA_DATA_DIR=/var/lib/whatsapp-translator
WA_SOCKET_PATH=/run/whatsapp-translator/http.sock
WA_ORIGIN=http://127.0.0.1:8787
WA_TRANSLATOR_COMMAND=/opt/node-v22.23.2-linux-x64/bin/node
WA_TRANSLATOR_ARGS='["/opt/whatsapp-translator/current/scripts/bridge-client.mjs"]'
WA_TRANSLATOR_LABEL=Claude Sonnet
ENV
  )
fi
if [[ -x /opt/whatsapp-translator/stt-venv/bin/python && -f /opt/whatsapp-translator/models/faster-whisper-small/model.bin ]]; then
  # Add optional local speech configuration without changing existing operator choices.
  python3 - <<'PY'
from pathlib import Path
path = Path('/etc/whatsapp-translator/application.env')
content = path.read_text()
present = {line.split('=', 1)[0] for line in content.splitlines() if '=' in line}
for key, value in {
    'WA_STT_PYTHON': '/opt/whatsapp-translator/stt-venv/bin/python',
    'WA_STT_MODEL': '/opt/whatsapp-translator/models/faster-whisper-small',
}.items():
    if key not in present:
        content = content.rstrip() + '\n' + key + '=' + value + '\n'
path.write_text(content)
path.chmod(0o600)
PY
fi
install -o root -g root -m 0755 "$release/infra/whatsapp-translation-socket.sh" /usr/local/sbin/whatsapp-translation-socket
for unit in whatsapp-translator.service whatsapp-translator-broker.socket whatsapp-translator-broker@.service; do
  install -o root -g root -m 0644 "$release/infra/$unit" "/etc/systemd/system/$unit"
done
ln -sfn "$release" /opt/whatsapp-translator/current
systemctl daemon-reload
systemctl enable --now whatsapp-translator-broker.socket
systemctl enable whatsapp-translator.service
systemctl restart whatsapp-translator.service
systemctl is-active --quiet whatsapp-translator.service whatsapp-translator-broker.socket
echo 'WhatsApp Translator service installed; existing application services were not restarted.'

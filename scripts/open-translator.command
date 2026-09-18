#!/bin/bash
set -euo pipefail
umask 077
# Keep this short: macOS limits Unix-domain socket paths to about 104 bytes.
ssh_socket="$HOME/.ssh/wa-translator.sock"
known_hosts=/Users/danilanazarenko/Documents/ChatGPT/MultiModeAgents/.state/hetzner/known_hosts
key_file="$HOME/.ssh/multimodeagents_hetzner_ed25519"
if ! ssh -S "$ssh_socket" -O check mma@2.28.227.134 >/dev/null 2>&1; then
  ssh -M -S "$ssh_socket" -fN \
    -o IdentitiesOnly=yes -o HostKeyAlgorithms=ssh-ed25519 \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" \
    -o BatchMode=yes -o ConnectTimeout=15 -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -i "$key_file" \
    -L 127.0.0.1:8787:/run/whatsapp-translator/http.sock mma@2.28.227.134
fi
echo 'Переводчик доступен: http://127.0.0.1:8787'
echo 'WhatsApp работает на сервере. Этот канал нужен только для открытия страницы с Mac.'

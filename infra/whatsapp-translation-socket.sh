#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) == 0 && $# == 0 ]] || exit 1
release=$(readlink -f /opt/whatsapp-translator/current)
[[ $release =~ ^/opt/whatsapp-translator/releases/[a-f0-9]{40}$ ]] || exit 1
for directory in /opt /opt/whatsapp-translator /opt/whatsapp-translator/releases "$release" "$release/scripts"; do
  [[ -d $directory && ! -L $directory && $(stat -c %u "$directory") == 0 ]] || exit 1
  mode=$(stat -c %a "$directory"); (( (8#$mode & 8#022) == 0 )) || exit 1
done
for script in "$release/scripts/bridge-socket.py" "$release/scripts/subscription-bridge.py"; do
  [[ -f $script && ! -L $script && $(stat -c %u "$script") == 0 && $(stat -c %h "$script") == 1 ]] || exit 1
  mode=$(stat -c %a "$script"); (( (8#$mode & 8#022) == 0 )) || exit 1
done
exec /usr/bin/python3 -I "$release/scripts/bridge-socket.py"

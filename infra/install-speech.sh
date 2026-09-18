#!/usr/bin/env bash
# Optional one-time local CPU speech runtime; no API credentials or inference.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) == 0 ]] || exit 1
base=/opt/whatsapp-translator
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
python3 -m venv "$base/stt-venv"
"$base/stt-venv/bin/pip" install --disable-pip-version-check -r "$source_dir/requirements-speech.txt"
HF_HUB_DISABLE_PROGRESS_BARS=1 HF_HUB_DISABLE_TELEMETRY=1 "$base/stt-venv/bin/python" - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id='Systran/faster-whisper-small',
    revision='536b0662742c02347bc0e980a01041f333bce120',
    local_dir='/opt/whatsapp-translator/models/faster-whisper-small',
    allow_patterns=['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'],
    token=False,
)
PY
chmod -R go-w "$base/stt-venv" "$base/models"
echo 'Local speech runtime installed. Run the application installer to enable it.'

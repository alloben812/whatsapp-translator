#!/usr/bin/env python3
"""Provision first owner password without printing it; updates preserve the hash."""
import hashlib
import os
from pathlib import Path
import re
import secrets
import stat


def private_file(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        raise RuntimeError('Unsafe owner credential file')


def write_private(path: Path, value: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as target:
        target.write(value)
        target.flush()
        os.fsync(target.fileno())


def provision(directory: Path) -> bool:
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError('Unsafe owner credential directory')
    digest_path = directory / 'owner-password.scrypt'
    initial_path = directory / 'owner-password.initial'
    if digest_path.exists() or digest_path.is_symlink():
        private_file(digest_path)
        value = digest_path.read_text().strip()
        if not re.fullmatch(r'scrypt\$16384\$8\$1\$[a-f0-9]{64}\$[a-f0-9]{128}', value):
            raise RuntimeError('Invalid owner password hash')
        return False
    # Keep the initial password recoverable if installation was interrupted.
    if initial_path.exists() or initial_path.is_symlink():
        private_file(initial_path)
        password = initial_path.read_text().strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{32}', password):
            raise RuntimeError('Invalid initial owner password')
    else:
        password = secrets.token_urlsafe(24)
        write_private(initial_path, password + '\n')
    salt = secrets.token_bytes(32)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
    write_private(digest_path, f'scrypt$16384$8$1${salt.hex()}${digest.hex()}\n')
    return True


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('Root is required')
    os.umask(0o077)
    created = provision(Path('/etc/whatsapp-translator'))
    print('Owner credential created' if created else 'Owner credential preserved')

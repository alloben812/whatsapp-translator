import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('owner_password', Path(__file__).parents[1] / 'scripts/provision-owner-password.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OwnerPasswordTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.directory.chmod(0o700)
        original_lstat = Path.lstat

        def root_owned(path, *args, **kwargs):
            # Tests run unprivileged; emulate root ownership, keep real modes/types.
            values = list(original_lstat(path, *args, **kwargs))
            values[4] = 0
            return os.stat_result(values)

        self.owner = patch.object(Path, 'lstat', root_owned)
        self.owner.start()

    def tearDown(self):
        self.owner.stop()
        self.temp.cleanup()

    @unittest.skipUnless(hasattr(hashlib, 'scrypt'), 'OpenSSL-enabled Python required; deployment and Linux CI provide it')
    def test_creates_valid_hash_and_preserves_it_after_handover(self):
        self.assertTrue(module.provision(self.directory))
        initial = self.directory / 'owner-password.initial'
        digest_path = self.directory / 'owner-password.scrypt'
        password = initial.read_text().strip()
        saved = digest_path.read_text().strip()
        _, n, r, p, salt, digest = saved.split('$')
        self.assertEqual(len(password), 32)
        self.assertEqual(hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=64).hex(), digest)
        self.assertEqual(initial.stat().st_mode & 0o777, 0o600)
        self.assertEqual(digest_path.stat().st_mode & 0o777, 0o600)
        initial.unlink()
        self.assertFalse(module.provision(self.directory))
        self.assertEqual(digest_path.read_text().strip(), saved)
        self.assertFalse(initial.exists())

    @unittest.skipUnless(hasattr(hashlib, 'scrypt'), 'OpenSSL-enabled Python required; deployment and Linux CI provide it')
    def test_resumes_interrupted_installation_without_changing_password(self):
        initial = self.directory / 'owner-password.initial'
        module.write_private(initial, 'A' * 32 + '\n')
        self.assertTrue(module.provision(self.directory))
        self.assertEqual(initial.read_text().strip(), 'A' * 32)

    def test_rejects_symlink_without_overwriting_target(self):
        target = self.directory / 'target'
        target.write_text('preserve')
        (self.directory / 'owner-password.initial').symlink_to(target)
        with self.assertRaises(RuntimeError):
            module.provision(self.directory)
        self.assertEqual(target.read_text(), 'preserve')

    def test_rejects_world_readable_initial_password(self):
        initial = self.directory / 'owner-password.initial'
        initial.write_text('A' * 32)
        initial.chmod(0o644)
        with self.assertRaises(RuntimeError):
            module.provision(self.directory)

    def test_rejects_corrupt_hash_instead_of_silently_replacing(self):
        module.write_private(self.directory / 'owner-password.scrypt', 'invalid')
        with self.assertRaises(RuntimeError):
            module.provision(self.directory)
        self.assertFalse((self.directory / 'owner-password.initial').exists())


if __name__ == '__main__':
    unittest.main()

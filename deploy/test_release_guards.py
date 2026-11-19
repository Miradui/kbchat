"""Exercise stop-write guards without touching Docker or a real database."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().with_name('release.sh')

class ReleaseGuards(unittest.TestCase):
    def test_backup_refuses_every_live_or_uncertain_backend_state(self):
        for state in ['running', 'restarting', 'paused', 'removing', 'dead']:
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'runtime.env').write_text('COMPOSE_PROJECT_NAME=fixture\n')
                docker = root / 'docker'
                docker.write_text('''#!/bin/sh
case "$*" in
  *" ps -a -q backend") echo fixture-container ;;
  "inspect "*) echo "$FIXTURE_STATE" ;;
  *) echo "unexpected mutation" >> "$FIXTURE_CALLS"; exit 90 ;;
esac
''')
                docker.chmod(0o755)
                env = dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'],
                           KBCHAT_ENV_FILE=str(root / 'runtime.env'), KBCHAT_OBSERVABILITY='false',
                           FIXTURE_STATE=state, FIXTURE_CALLS=str(root / 'calls'))
                result = subprocess.run(['bash', str(SCRIPT), 'backup', str(root / 'backup')],
                                        env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Backend is ' + state, result.stderr)
                self.assertFalse((root / 'backup').exists())
                self.assertFalse((root / 'calls').exists())

    def test_docker_inspection_failure_does_not_allow_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'runtime.env').write_text('COMPOSE_PROJECT_NAME=fixture\n')
            docker = root / 'docker'
            docker.write_text('#!/bin/sh\nexit 42\n')
            docker.chmod(0o755)
            env = dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'],
                       KBCHAT_ENV_FILE=str(root / 'runtime.env'), KBCHAT_OBSERVABILITY='false')
            result = subprocess.run(['bash', str(SCRIPT), 'backup', str(root / 'backup')],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'backup').exists())

if __name__ == '__main__':
    unittest.main()

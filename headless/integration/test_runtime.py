import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]


class LinuxRuntimeTest(unittest.TestCase):
    def test_singleton_lock_survives_exec_and_releases_when_process_exits(self):
        with tempfile.TemporaryDirectory(prefix='codex-drops-lock-') as temporary:
            directory = Path(temporary)
            filename = directory / 'config.json'
            filename.write_text(json.dumps({'dataDir': 'state'}))
            # A fake node holds the exec process alive, without network or accounts.
            executable = directory / 'node'
            executable.write_text(f'#!{sys.executable}\nimport time\nprint("ready",flush=True)\ntime.sleep(30)\n')
            executable.chmod(0o700)
            environment = {**os.environ, 'PATH': str(directory) + os.pathsep + os.environ['PATH']}
            command = [sys.executable, str(ROOT / 'headless/run.py'), '--config', str(filename)]
            owner = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(owner.stdout.readline().strip(), 'ready')
                duplicate = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(duplicate.returncode, 0)
                self.assertIn('agent_already_running', duplicate.stderr)
            finally:
                owner.terminate()
                owner.wait(timeout=5)
                owner.stdout.close()
            with (directory / 'state/agent.lock').open('a+b') as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_idle_bridge_exits_on_sigterm_and_records_stopped_state(self):
        with tempfile.TemporaryDirectory(prefix='codex-drops-bridge-') as temporary:
            directory = Path(temporary)
            (directory / 'miner-control.json').write_text(json.dumps({'run': False, 'updatedAt': time.time() * 1000}))
            process = subprocess.Popen([sys.executable, str(ROOT / 'headless/miner_bridge.py'), '--data-dir', temporary], env={**os.environ, 'PYTHONPATH': str(ROOT)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                for _ in range(50):
                    if (directory / 'miner-status.json').exists():
                        break
                    time.sleep(0.1)
                self.assertTrue((directory / 'miner-status.json').exists())
                process.terminate()
                self.assertEqual(process.wait(timeout=5), 0)
                state = json.loads((directory / 'miner-status.json').read_text())
                self.assertFalse(state['running'])
                self.assertEqual(state['threadCount'], 4)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stdout.close()
                process.stderr.close()


if __name__ == '__main__':
    unittest.main()

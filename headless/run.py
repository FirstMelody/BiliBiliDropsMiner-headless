"""Hold a kernel singleton lock across exec; no cookie or token in argv."""
import fcntl
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
args = sys.argv[1:]
try:
    filename = Path(args[args.index('--config') + 1]) if '--config' in args else ROOT / 'headless/config.json'
    config = json.loads(filename.read_text(encoding='utf-8'))
    data = (filename.resolve().parent / config.get('dataDir', '../data')).resolve()
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(data, 0o700)
    descriptor = os.open(data / 'agent.lock', os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('agent_already_running')
    os.set_inheritable(descriptor, True)
except (OSError, ValueError, IndexError, TypeError):
    raise SystemExit('config_unreadable_or_invalid')
os.chdir(ROOT)
os.execvp('node', ['node', str(ROOT / 'headless/agent.mjs'), *args])

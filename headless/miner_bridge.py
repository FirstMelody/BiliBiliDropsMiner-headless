"""Start the original miner with four sessions; never put cookies in argv."""
import json
import logging
import os
from pathlib import Path
import re
import threading
import time
import sys
import argparse
import fcntl
import signal

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

from bilibili_drops_miner.config import MinerConfig
from bilibili_drops_miner.miner import BilibiliWatchTimeMiner

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--data-dir', type=Path, required=True)
DATA = parser.parse_args().data_dir
singleton = (DATA / 'miner-process.lock').open('a+b')
singleton.seek(0)
try:
    fcntl.flock(singleton, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    raise SystemExit(0)
miner = None
owner = None
generation = None
last_error = None
stop_requested = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop_requested.set())
signal.signal(signal.SIGINT, lambda *_: stop_requested.set())

class SafeLog(logging.Handler):
    def emit(self, record):
        global last_error
        message = record.getMessage()
        if '登录成功:' in message:
            message = 'miner login verified'
        message = re.sub(r'https?://\S+', '[URL]', message)
        message = re.sub(r'(SESSDATA|bili_jct|refresh_token)=[^;\s]+', r'\1=[redacted]', message)
        if record.levelno >= logging.WARNING:
            last_error = message[:180]
        print(time.strftime('%Y-%m-%dT%H:%M:%S'), message, flush=True)

logging.basicConfig(level=logging.INFO, handlers=[SafeLog()])
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)

def read_cookie():
    session = json.loads((DATA / 'session.json').read_text(encoding='utf-8'))
    values = {c['name']: c['value'] for c in session['cookies'] if c['domain'].endswith('bilibili.com')}
    return '; '.join(f'{k}={v}' for k, v in values.items())

def run_miner(instance):
    global last_error
    try:
        instance.run()
    except Exception as error:
        last_error = type(error).__name__
        logging.error('miner stopped with %s', type(error).__name__)

def stop_miner():
    global miner, owner
    if miner:
        miner.stop()
    if owner:
        owner.join(timeout=30)
        if owner.is_alive():
            raise RuntimeError('miner_stop_timeout')
    miner = None
    owner = None

def write_status(desired):
    status = {'pid': os.getpid(), 'desired': desired,
              'threadCount': 4, 'activeSessions': miner.active_session_count if miner else 0,
              'running': bool(owner and owner.is_alive()),
              'updatedAt': time.time(), 'lastError': last_error}
    temporary = DATA / 'miner-status.json.tmp'
    temporary.write_text(json.dumps(status), encoding='utf-8')
    temporary.replace(DATA / 'miner-status.json')

try:
    while not stop_requested.is_set():
        command = json.loads((DATA / 'miner-control.json').read_text(encoding='utf-8'))
        # Supervisor lease expires after a crash so hanging cannot continue forever.
        desired = bool(command.get('run') and time.time()*1000 - command.get('updatedAt', 0) < 180000)
        if owner and not owner.is_alive():
            stop_miner()
        if not desired:
            stop_miner()
        elif not miner:
            config = MinerConfig(cookie=read_cookie(), room_ids=[command['roomId']],
                                 thread_count=4, task_ids=[], notify_on_task_complete=False)
            config.validate()
            miner = BilibiliWatchTimeMiner(config)
            generation = command.get('sessionGeneration')
            owner = threading.Thread(target=run_miner, args=(miner,), daemon=True)
            owner.start()
        elif generation != command.get('sessionGeneration'):
            miner.update_cookie(read_cookie())
            generation = command.get('sessionGeneration')
        write_status(desired)
        if command.get('exit'):
            break
        stop_requested.wait(5)
finally:
    stop_miner()
    write_status(False)

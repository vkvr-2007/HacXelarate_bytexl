"""Scan worker. Polls the Postgres queue and schedules rescans.

    python ml/worker.py           # run until stopped
    python ml/worker.py --once    # run what is queued or due, then exit (cron, CI)
"""
import argparse
import logging
import os
import signal
import socket
import time

import service  # loads .env and the model
from brandml import jobs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--poll', type=float, default=float(service.os.getenv('WORKER_POLL_SECONDS', '5')))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    log = logging.getLogger('signalguard.worker')
    stopping = {'flag': False}
    signal.signal(signal.SIGTERM, lambda *a: stopping.update(flag=True))
    signal.signal(signal.SIGINT, lambda *a: stopping.update(flag=True))
    who = (f'{socket.gethostname()}-{os.getpid()}', 'worker')
    if args.once:
        log.info('%s', jobs.run_pending(service.engine, budget_seconds=float(service.os.getenv('WORKER_BUDGET_SECONDS', '240')), who=who))
        return
    log.info('worker started, polling every %ss', args.poll)
    while not stopping['flag']:
        try:
            result = jobs.run_pending(service.engine, budget_seconds=120, max_jobs=5, who=who)
            if result['ran'] or result['scheduled'] or result['reaped']:
                log.info('%s', result)
        except Exception:
            log.exception('worker loop error; retrying')
        time.sleep(args.poll)


if __name__ == '__main__':
    main()

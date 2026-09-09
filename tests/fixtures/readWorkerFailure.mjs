import { parentPort } from 'node:worker_threads';
parentPort.on('message', ({ id, kind }) => {
  if (kind === 'crash') process.exit(17);
  parentPort.postMessage({ id, value: 'restarted' });
});

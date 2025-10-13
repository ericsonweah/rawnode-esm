import { parentPort } from 'node:worker_threads';
parentPort?.on('message', (msg) => {
  // TODO: implement scan/analyze workloads here
  parentPort.postMessage({ id: msg.id, result: msg }); // echo for now
});

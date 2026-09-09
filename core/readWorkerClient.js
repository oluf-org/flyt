import { Worker } from 'node:worker_threads';

export const readWorkerMetrics = { syncReadBytes: 0, summaryReadCalls: 0 };
const aborted = () => Object.assign(new Error('Read cancelled'), { name: 'AbortError', code: 'read_cancelled' });

// One bounded CPU lane per API. Terminating an obsolete active read also stops
// a single huge JSON.parse; queued requests for other projects remain intact.
export class ReadWorkerClient {
  #worker = null;
  #queue = [];
  #active = null;
  #closed = false;
  #stopping = false;
  #termination = Promise.resolve();
  #nextId = 0;
  #workerURL;

  constructor({ workerURL = new URL('./readWorker.js', import.meta.url) } = {}) {
    this.#workerURL = workerURL;
  }

  request(kind, args, { signal, onBatch } = {}) {
    if (this.#closed) return Promise.reject(new Error('Read worker is closed'));
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.#queue.length >= 128) return Promise.reject(new Error('Read worker queue is full'));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.#nextId, kind, args, signal, onBatch, resolve, reject, rows: [] };
      job.abort = () => {
        if (this.#active === job) {
          const worker = this.#worker;
          this.#worker = null;
          this.#stopping = true;
          this.#finish(job, aborted());
          // Start the next job only once the old CPU lane has stopped.
          this.#stop(worker);
        } else {
          this.#queue = this.#queue.filter(item => item !== job);
          job.signal?.removeEventListener('abort', job.abort);
          reject(aborted());
        }
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.#queue.push(job);
      this.#pump();
    });
  }

  #finish(job, error, value) {
    if (this.#active !== job) return;
    this.#active = null;
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(value);
    this.#worker?.unref();
  }

  #stop(worker) {
    this.#stopping = true;
    this.#termination = worker.terminate().finally(() => { this.#stopping = false; this.#pump(); });
  }

  #pump() {
    if (this.#closed || this.#stopping || this.#active || !this.#queue.length) return;
    if (!this.#worker) {
      let worker;
      try { worker = new Worker(this.#workerURL); }
      catch (error) {
        for (const job of this.#queue.splice(0)) {
          job.signal?.removeEventListener('abort', job.abort);
          job.reject(error);
        }
        return;
      }
      this.#worker = worker;
      worker.on('message', message => {
        if (this.#worker !== worker || message.id !== this.#active?.id) return;
        const job = this.#active;
        if (message.batch) {
          job.rows.push(...message.batch);
          try { job.onBatch?.(message.batch); }
          catch (error) {
            this.#finish(job, error); this.#worker = null; this.#stopping = true;
            this.#stop(worker);
          }
          return;
        }
        for (const key of Object.keys(readWorkerMetrics)) readWorkerMetrics[key] += message.metrics?.[key] ?? 0;
        const error = message.error && Object.assign(new Error(message.error.message), message.error);
        this.#finish(job, error, message.batched ? job.rows : message.value);
        this.#pump();
      });
      const fail = error => {
        if (this.#worker !== worker) return;
        this.#worker = null;
        this.#stopping = true;
        if (this.#active) this.#finish(this.#active, error);
        this.#stop(worker);
      };
      worker.on('error', fail);
      worker.on('exit', code => fail(new Error(`Read worker exited (${code})`)));
    }
    const job = this.#queue.shift();
    this.#active = job;
    this.#worker.ref();
    try { this.#worker.postMessage({ id: job.id, kind: job.kind, ...job.args }); }
    catch (error) { this.#finish(job, error); this.#pump(); }
  }

  async close() {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) {
      job.signal?.removeEventListener('abort', job.abort);
      job.reject(aborted());
    }
    const worker = this.#worker;
    if (this.#active) this.#finish(this.#active, aborted());
    this.#worker = null;
    await worker?.terminate();
    await this.#termination;
  }
}

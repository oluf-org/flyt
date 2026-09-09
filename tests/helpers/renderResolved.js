import { PassThrough } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';

// Wait for lazy destinations; synchronous SSR intentionally returns their
// loading state and cannot assert the contents of the loaded screen.
export function renderResolved(element) {
  return new Promise((resolve, reject) => {
    const output = new PassThrough(); let html = '';
    output.on('data', chunk => { html += chunk; });
    output.on('end', () => resolve(html)); output.on('error', reject);
    const stream = renderToPipeableStream(element, { onAllReady() { stream.pipe(output); }, onError: reject });
  });
}

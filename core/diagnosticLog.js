import fs from 'node:fs';
import path from 'node:path';

const printableError = value => {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack ?? null };
  if (value && typeof value === 'object') {
    try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
  }
  return String(value ?? '');
};

/** A small append-only desktop log that survives the process it describes. */
export function createDiagnosticLog(file) {
  const write = (level, event, details = null) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({
        at: new Date().toISOString(), level, event,
        ...(details == null ? {} : { details: printableError(details) }),
      })}\n`, 'utf8');
    } catch { /* diagnostics may never become the crash */ }
  };
  return {
    file,
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, details) => write('error', event, details),
  };
}

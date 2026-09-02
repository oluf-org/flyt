export { SandboxUnavailableError } from '../seams/sandbox.js';

export class SandboxDeniedError extends Error {
  readonly code = 'SANDBOX_DENIED';
  constructor(message: string) { super(message); this.name = 'SandboxDeniedError'; }
}

export class SandboxRunnerError extends Error {
  readonly code = 'SANDBOX_RUNNER_FAILED';
  constructor(message: string) { super(message); this.name = 'SandboxRunnerError'; }
}

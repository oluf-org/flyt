import type { JsonValue } from '../types.js';

/** Host observations, never fields accepted from a model's completion report. */
export interface WorkspaceEvidence {
  id: string;
  digest: string;
  partial: boolean;
  files: string[];
}
export interface ChangeEvidence {
  before: WorkspaceEvidence;
  after: WorkspaceEvidence;
  files: string[];
  text: string;
  truncated: boolean;
}
export interface WorkflowLimits {
  calls: number;
  minutes: number;
  usd?: number;
}
/** A host adapter for observations and accounting; it cannot execute project commands. */
export interface WorkflowSupport {
  capture(runId: string, key: string): Promise<WorkspaceEvidence>;
  changes(runId: string, before: WorkspaceEvidence, after: WorkspaceEvidence): Promise<ChangeEvidence>;
  comparison(runId: string, key: string, base: string): Promise<ChangeEvidence>;
  gates(): string[];
  bindBudget(runId: string, blockId: string, after: number, limits: WorkflowLimits): Promise<{ deadline: number }>;
}
declare module '@deepseek-ai/cordis' {
  interface Context { workflowSupport: WorkflowSupport; }
}

export interface Completion {
  status: 'implemented' | 'already-satisfied' | 'blocked';
  summary: string;
  criteria: string[];
  files: string[];
  verificationCommands: string[];
  evidence: string[];
  reproduction: string;
  remaining: string[];
}
export interface Review {
  verdict: 'pass' | 'repair' | 'blocked';
  summary: string;
  criteria: { criterion: string; passed: boolean; evidence: string; references: { file: string; line: number; quote: string }[] }[];
  findings: { file: string; line: number; trigger: string; consequence: string; evidence: string }[];
  coverage: string[];
}
export interface Milestone {
  id: string;
  title: string;
  goal: string;
  acceptance: string[];
}
export interface MilestonePlan { summary: string; milestones: Milestone[]; }

const strings = { type: 'array', items: { type: 'string' }, maxItems: 40 };
const text = { type: 'string', minLength: 1 };
export const COMPLETION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'criteria', 'files', 'verificationCommands', 'evidence', 'reproduction', 'remaining'],
  properties: { status: { enum: ['implemented', 'already-satisfied', 'blocked'] }, summary: text,
    criteria: { ...strings, minItems: 1 }, files: { ...strings, description: 'Exact workspace-relative paths changed, or [] when already satisfied.' },
    verificationCommands: { ...strings, description: 'Only executable shell command strings to verify the result. Use [] when source inspection suffices; put read-back observations in evidence instead. Never put explanations or reader tool calls here.' }, evidence: strings,
    reproduction: { type: 'string' }, remaining: { ...strings, description: 'Only unmet mandatory requirements that need repair. Put optional improvements and nonblocking limitations in evidence. Use blocked status for an unavailable dependency or required human decision.' } },
} as const;
export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'criteria', 'findings', 'coverage'],
  properties: { verdict: { enum: ['pass', 'repair', 'blocked'] }, summary: text,
    criteria: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false,
      required: ['criterion', 'passed', 'evidence', 'references'], properties: { criterion: text, passed: { type: 'boolean', description: 'True only when observed evidence establishes this requirement. A pass verdict requires every criterion to be true; false means the requirement is unmet or unverified.' }, evidence: text,
        references: { type: 'array', maxItems: 20,
          description: 'Source-file references only, each exactly {file,line,quote}. Describe observed command receipts in the evidence string; never put tool/command/result objects in references.',
          items: { type: 'object', additionalProperties: false, required: ['file', 'line', 'quote'],
          properties: { file: { ...text, description: 'Exact workspace-relative path.' }, line: { type: 'integer', minimum: 1 },
            quote: { ...text, description: 'Verbatim current file text at this line, without reader line-number prefixes. Use [absent] at line 1 for deleted files, [empty] for an empty file.' } } } } } } },
    findings: { type: 'array', maxItems: 30, description: 'Only concrete defects in current behavior introduced by this change. Missing tests alone, optional improvements, and hypothetical future regressions belong in summary limitations, not findings. A pass has an empty findings array.', items: { type: 'object', additionalProperties: false,
      required: ['file', 'line', 'trigger', 'consequence', 'evidence'],
      properties: { file: text, line: { type: 'integer', minimum: 1 }, trigger: text, consequence: text, evidence: text } } },
    coverage: { ...strings, minItems: 1, description: 'Exact workspace-relative paths reviewed, one path per entry.' } },
} as const;
export const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'milestones'],
  properties: { summary: text, milestones: { type: 'array', minItems: 1, maxItems: 8,
    items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'goal', 'acceptance'],
      properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' }, title: text, goal: text,
        acceptance: { ...strings, minItems: 1 } } } } },
} as const;
export const SPEC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'specification', 'assumptions', 'openDecisions'],
  properties: { status: { enum: ['ready', 'draft'] }, specification: text, assumptions: strings,
    openDecisions: { ...strings, description: 'Only unresolved decisions that block implementation. Put chosen defaults and optional future alternatives in assumptions.' } },
} as const;
export interface Specification {
  status: 'ready' | 'draft'; specification: string; assumptions: string[]; openDecisions: string[];
}
export interface SpecificationReview {
  verdict: 'pass' | 'repair'; summary: string;
  checks: { interfaces: string; examples: string; failureOrdering: string; decisions: string };
  issues: string[]; blockingDecisions: string[];
}
export const SPEC_REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'summary', 'checks', 'issues', 'blockingDecisions'],
  properties: { verdict: { enum: ['pass', 'repair'] }, summary: text,
    checks: { type: 'object', additionalProperties: false,
      required: ['interfaces', 'examples', 'failureOrdering', 'decisions'],
      properties: { interfaces: text, examples: text, failureOrdering: text, decisions: text } },
    issues: { ...strings, description: 'Concrete contradictions, missing mandatory requirements, or incorrect examples to repair. No optional enhancements.' },
    blockingDecisions: { ...strings, description: 'Consequential stakeholder decisions still unresolved. These require draft status even when the specification is internally consistent.' } },
} as const;
export const RESEARCH_REPAIR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'replacements', 'replaceAnswer', 'answer', 'limitations'],
  properties: { status: { enum: ['answered', 'insufficient-evidence'] },
    replacements: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false,
      required: ['index', 'kind', 'source', 'quote'], properties: { index: { type: 'integer', minimum: 0, maximum: 29 },
        kind: { enum: ['input', 'file', 'web'] }, source: text, quote: text } } },
    replaceAnswer: { type: 'boolean', description: 'False preserves the existing answer. True replaces it only when substantive claims must change to match the evidence.' },
    answer: { type: 'string', description: 'Use an empty string when replaceAnswer is false. Otherwise supply the complete corrected answer; never the literal string null.' },
    limitations: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 40,
      description: 'Null preserves existing limitations.' } },
} as const;
export const RESEARCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'answer', 'sources', 'limitations'],
  properties: { status: { enum: ['answered', 'insufficient-evidence'] }, answer: text, limitations: strings,
    sources: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false,
      required: ['kind', 'source', 'quote'], properties: { kind: { enum: ['input', 'file', 'web'] }, source: text,
        quote: { ...text, description: 'One short contiguous verbatim excerpt copied from the opened result. No ellipses, paraphrase, added explanations, or reconstructed whole files. Use separate sources for separate excerpts.' } } } } },
} as const;

export const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));

export function reviewAccepted(review: Review): boolean {
  return review.verdict === 'pass' && review.findings.length === 0
    && review.criteria.length > 0 && review.criteria.every(item => item.passed && item.evidence.trim());
}

/**
 * `flyt-blocks-inquiry` — the blocks that ask and orient.
 *
 * Interrogate and orient. Interrogate questions the person behind the request
 * over bounded rounds and writes the specification their answers settled;
 * orient surveys the workspace and the subject and says what relationship they
 * have. Both read the repository to ground themselves, so they name a read-only
 * ceiling (D57) — and can write nothing.
 *
 * @module #kernel/plugins/blocks-inquiry
 */
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '../types.js';
import type { BlockDefinition, BlockRun } from '../blocks/types.js';
import { AI_STEP_SETTINGS, executeAiStep } from './blocks-aistep.js';

/** Cordis plugin name. */
export const name = 'flyt-blocks-inquiry';

/** It contributes blocks, so it needs the registry. */
export const inject = ['blocks', 'sessions'];

/** What an inquiry block may reach: read the project, nothing else. */
const INQUIRY_CEILING = ['read_file', 'glob', 'search_files', 'search_references'] as const;

const inquire = (
  use: string, title: string, description: string, brief: string,
): BlockDefinition => ({
  use, title, description, category: 'inquiry',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: INQUIRY_CEILING,
  execute: (run: BlockRun) => executeAiStep(run, brief),
});

export const interrogateBlock = inquire(
  'flyt-blocks-inquiry:interrogate', 'Interrogate',
  'Question the person behind the request over bounded rounds, then write the specification their answers settled.',
  'Interrogate the request over a few bounded rounds — goal, non-goals, constraints, acceptance — then write the specification the answers settle. Mark every assumption you had to take as an assumption; do not present one as a decision.',
);
export const orientBlock = inquire(
  'flyt-blocks-inquiry:orient', 'Orient',
  'Survey the workspace and the subject, and say what relationship they have. Everything downstream is aimed by its answer.',
  'Say what THIS project is and what relationship it has to the subject about to be read: empty, the same kind of thing, overlapping problems, or no real overlap. Read enough to argue it — the manifests and guidance, plus at most two load-bearing files from each side — then stop. This is a bounded survey, not the analysis.',
);

/** Contribute the inquiry blocks. */
export function apply(ctx: Context): void {
  ctx.blocks.register(interrogateBlock);
  ctx.blocks.register(orientBlock);
}

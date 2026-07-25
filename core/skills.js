// Skills: reusable expertise a node template attaches BY NAME, resolved at run
// time against the bound project's .flyt/skills/<name>.md (D15 — per-project
// config is version-controllable and travels with the repo).
//
// The indirection is the whole point. A template names a skill it wants
// ("house-style"); each project supplies its own file. So workflows and
// templates stay workspace-agnostic (Q-D5) while what they actually DO adapts
// per repo: the same "Code (general)" node follows this project's conventions
// because this project committed them next to its code.
//
// A skill contributes INSTRUCTIONS ONLY. It deliberately cannot grant tools:
// the template's `tools` allowlist and the approval gates are the safety
// envelope (V1 task 4), and a skill that could widen the tool set would let
// expertise quietly expand what an agent is allowed to do.
import fs from 'node:fs';
import { CONFIG_DIR } from './brand.js';

// Skill names come from templates and flow YAML, i.e. from users, and are
// interpolated into a path. Confining the NAME is the first of two defenses;
// Workspace.resolve() is the second (it also catches symlink escapes).
const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

// Workspace-relative. `dir` is the project's config directory name, which a
// pre-D29 project still reports as the legacy one until a write adopts it — so
// skills keep resolving either way (core/workspace.js).
export const SKILLS_DIR = `${CONFIG_DIR}/skills`;
export const skillPath = (name, dir = CONFIG_DIR) => `${dir}/skills/${name}.md`;

// Resolve attached skill names against a bound workspace.
// Returns { found: [{ name, content }], missing: [{ name, reason }] }.
// Missing is never fatal — a node whose skill file isn't there still runs, it
// just runs without that expertise — but every miss carries a reason so the
// audit log can say WHY nothing was injected.
export function loadSkills(workspace, names) {
  const found = [];
  const missing = [];
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    if (!SAFE_NAME.test(name)) {
      missing.push({ name, reason: 'invalid skill name (letters, digits, _ and - only)' });
      continue;
    }
    if (!workspace) {
      missing.push({ name, reason: 'no workspace bound to this run' });
      continue;
    }
    const rel = skillPath(name, workspace.configDirName);
    let content = null;
    try {
      const p = workspace.resolve(rel);
      content = fs.existsSync(p) && fs.statSync(p).isFile()
        ? fs.readFileSync(p, 'utf8').trim()
        : null;
    } catch (err) {
      missing.push({ name, reason: String(err?.message ?? err) });
      continue;
    }
    if (content) found.push({ name, content });
    else missing.push({ name, reason: `no ${rel} in the workspace` });
  }
  return { found, missing };
}

// Render resolved skills as a system-prompt section. Empty string when there is
// nothing to add, so callers can append unconditionally.
export function skillsSection(found) {
  if (!found?.length) return '';
  return [
    'SKILLS — expertise attached to this node, taken from the bound project.',
    'These describe how work is done in THIS repository. Follow them: where they',
    'conflict with your general habits, they win.',
    ...found.map(s => `\n--- skill: ${s.name} ---\n${s.content}`)
  ].join('\n');
}

// Append the section to a system prompt (unchanged when there are none).
export function withSkillsSection(system, found) {
  const section = skillsSection(found);
  return section ? `${system}\n\n${section}` : system;
}

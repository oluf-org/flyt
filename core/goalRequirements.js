// Project readiness is advisory. A reusable definition never depends on a
// particular checkout existing, and diagnostics never read file contents.
import fs from 'node:fs';
import path from 'node:path';

export function validateRequiredPaths(paths = []) {
  if (!Array.isArray(paths) || paths.length > 100 || paths.some(value => typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\0\r\n]/.test(value))) {
    throw new Error('Required paths must be a list of up to 100 nonempty paths');
  }
  return [...new Set(paths.map(value => value.trim()))];
}

export function goalFolder(definition, project) {
  const base = project.folder || project.workspaceRoot;
  // Relative bindings must never be resolved against the application's cwd.
  return path.resolve(base, definition.folder || '.');
}

const escapes = relative => relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
const absolute = value => path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('~');
function checkPath(root, value) {
  if (absolute(value)) return { status: 'absolute', message: 'Uses a machine-specific path. Change it to a path relative to this workspace.' };
  const target = path.resolve(root, value.replaceAll('\\', '/'));
  if (escapes(path.relative(root, target))) return { status: 'outside', message: 'Points outside this workspace. Provide the dependency inside the project or update the path.' };
  try {
    // Check every existing ancestor, including dangling links. Never follow a
    // junction outside the workspace even when the final leaf is missing.
    let current = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() && escapes(path.relative(root, fs.realpathSync(current)))) return { status: 'outside', message: 'A link points outside this workspace.' };
    }
    return { status: 'present', message: 'Available in this workspace.' };
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR'
      ? { status: 'missing', message: 'Missing from this workspace. Add it to the project or update the path.' }
      : { status: 'unreadable', message: 'This path could not be inspected. Check access to it.' };
  }
}

export function goalRequirements(definition, project, { workspace = null, references = [] } = {}) {
  const warnings = [], paths = [];
  let root;
  try {
    root = fs.realpathSync(workspace || goalFolder(definition, project));
    if (!fs.statSync(root).isDirectory()) throw new Error('Not a directory');
  } catch {
    return { folder: workspace || definition.folder || project.folder || project.workspaceRoot, paths, warnings: [{ code: 'workspace', address: 'goal/folder', message: 'Workspace folder is unavailable. Choose an existing folder before starting.' }] };
  }
  const dedicated = !workspace && Boolean(definition.createFolder);
  const requirements = validateRequiredPaths(definition.requiredPaths);
  for (const value of requirements) {
    let result = checkPath(root, value);
    if (dedicated && result.status === 'present') result = { status: 'new_workspace', message: 'Exists in the parent project, but will not be copied into the new Goal folder. Use the project folder or provide it during setup.' };
    paths.push({ path: value, address: 'goal/requiredPaths', ...result });
  }
  if (dedicated) warnings.push({ code: 'dedicated_workspace', address: 'goal/createFolder', message: 'This loop starts in a new, empty folder. Project files are not copied into it.' });
  // Clearly marked references are suggestions, not guessed prerequisites.
  // Outputs are created by the loop and must not be reported as missing inputs.
  const outputs = new Set((definition.criteria ?? []).filter(item => item.type === 'file_contains').map(item => item.path));
  const seen = new Set(requirements);
  for (const { path: value, address } of references) {
    if (seen.has(value) || outputs.has(value) || /[*?{}]/.test(value)) continue;
    seen.add(value);
    const result = checkPath(root, value);
    if (result.status !== 'present') paths.push({ path: value, address, inferred: true, ...result,
      message: `Referenced by this loop. ${result.message} If this is an output, it may be created during execution.` });
    if (paths.length >= 150) break;
  }
  return { folder: root, paths, warnings };
}

export function referencedGoalPaths(fields) {
  const references = [];
  for (const [address, value] of fields) {
    if (typeof value !== 'string' || !/^(goal\/(objective|constraints)|(?:recipe|setup)\/[^/]+\/config\/)/.test(address)) continue;
    if (/(?:path|file|directory|folder)$/i.test(address) && value.trim() && !/\r|\n/.test(value)) references.push({ address, path: value.trim() });
    const text = value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s`"'<>]+/gi, '');
    for (const match of text.matchAll(/`([^`\r\n]+)`/g)) {
      const candidate = match[1].trim();
      if (!candidate.includes('://') && (absolute(candidate) || /^(?:[\w.@-]+[\\/])+[\w. @-]*$/.test(candidate) || /^[\w.-]+\.[a-zA-Z0-9]{1,12}$/.test(candidate))) references.push({ address, path: candidate });
    }
    // Catch hard-coded drive paths even when older prompts did not quote them.
    for (const match of text.matchAll(/(?<![\w])[A-Za-z]:[\\/][^\s`"'<>]+/g)) references.push({ address, path: match[0].replace(/[.,;)]*$/, '') });
    for (const match of text.matchAll(/(?<![\w.@:\/\\-])(?:[\w.@-]+[\/\\])+[\w.@-]+\.[a-zA-Z0-9_-]{1,12}\b/g)) references.push({ address, path: match[0] });
  }
  return references;
}

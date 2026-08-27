/**
 * Finding the layers, and mounting what they compose.
 *
 * Discovery reads `dsh.bundle` and `dsh.profile` out of installed packages'
 * `package.json`, exactly as dsh does, so a package written for their loader
 * is found by ours (D54). Everything after discovery is {@link compose}.
 *
 * @module #kernel/loader
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { parseYaml, type YamlValue } from './yaml.js';
import { compose, type Entry, type Layer, type ResolvedEntry } from './compose.js';
import { installPlugin, pluginInjections, type AttendedPluginReview } from '../plugins/tools.js';

export * from './compose.js';
export * from './yaml.js';

/** Read a composition file. `.yml`/`.yaml` and `.json` are both accepted. */
export function readComposition(file: string, source = file): Layer {
  const text = fs.readFileSync(file, 'utf8');
  const parsed: YamlValue = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  const entries = Array.isArray(parsed) ? parsed : parsed === null ? [] : null;
  if (!entries) throw new Error(`${file}: a composition file is a list of entries`);
  const seen = new Set<string>();
  for (const entry of entries as unknown as Entry[]) {
    if (!entry || typeof entry !== 'object') throw new Error(`${file}: an entry must be a mapping`);
    if (!entry.id) throw new Error(`${file}: every entry needs an id`);
    if (seen.has(entry.id)) throw new Error(`${file}: two entries share the id "${entry.id}"`);
    seen.add(entry.id);
  }
  return { source, entries: entries as unknown as Entry[] };
}

/** What a package contributes, read from its `dsh` field. */
export interface PackageContribution {
  packageName: string;
  /** A composition file whose rows join the tree. */
  bundle?: string;
  /** A named profile this package supplies a patch for. */
  profile?: string;
  /** The patch file, when the package declares a profile. */
  patch?: string;
}

/**
 * Read one package's contribution.
 *
 * A package with no `dsh` field contributes nothing, which is the normal case
 * and not an error — most installed packages are not plugins.
 *
 * @param packageDir — the package's directory.
 * @returns its contribution, or null.
 */
export function readContribution(packageDir: string): PackageContribution | null {
  const manifest = path.join(packageDir, 'package.json');
  if (!fs.existsSync(manifest)) return null;
  let parsed: any;
  try { parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { return null; }
  const dsh = parsed?.dsh;
  if (!dsh || typeof dsh !== 'object') return null;
  const out: PackageContribution = { packageName: String(parsed.name ?? path.basename(packageDir)) };
  if (dsh.bundle) out.bundle = path.resolve(packageDir, String(dsh.bundle));
  if (dsh.profile) out.profile = String(dsh.profile);
  if (dsh.patch) out.patch = path.resolve(packageDir, String(dsh.patch));
  return out;
}

/**
 * Every contributing package under a `node_modules` directory, scoped packages
 * included.
 *
 * Sorted by package name so a tree composed twice from the same install is the
 * same tree. Discovery order is not a place for filesystem luck.
 *
 * @param nodeModules — the directory to scan.
 * @returns the contributions, sorted by package name.
 */
export function discoverContributions(nodeModules: string): PackageContribution[] {
  if (!fs.existsSync(nodeModules)) return [];
  const dirs: string[] = [];
  for (const name of fs.readdirSync(nodeModules)) {
    const full = path.join(nodeModules, name);
    if (name.startsWith('@')) {
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
      for (const scoped of fs.readdirSync(full)) dirs.push(path.join(full, scoped));
    } else {
      dirs.push(full);
    }
  }
  return dirs
    .map(readContribution)
    .filter((c): c is PackageContribution => Boolean(c))
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
}

/** Where the four layers come from. */
export interface CompositionSources {
  /** Package contributions, usually from {@link discoverContributions}. */
  contributions?: PackageContribution[];
  /** Which profile's patches apply. */
  profile?: string;
  /** The profile's own rows, when Flyt ships it rather than a package. */
  profileEntries?: Entry[];
  /** `~/.flyt/cordis.patch.yml` — the machine's standing preferences. */
  home?: string;
  /** Rows named on the command line, highest precedence. */
  overlay?: Entry[];
}

/**
 * Build the four layers, in order, and resolve them.
 *
 * @param sources — where each layer comes from.
 * @returns the resolved rows and the layers they came from.
 */
export function loadComposition(sources: CompositionSources = {}): { entries: ResolvedEntry[]; layers: Layer[] } {
  const layers: Layer[] = [];

  for (const contribution of sources.contributions ?? []) {
    if (!contribution.bundle) continue;
    layers.push(readComposition(contribution.bundle, `bundle:${contribution.packageName}`));
  }

  if (sources.profileEntries) {
    layers.push({ source: `profile:${sources.profile ?? 'unnamed'}`, entries: sources.profileEntries });
  }
  for (const contribution of sources.contributions ?? []) {
    if (!contribution.patch || !contribution.profile) continue;
    if (sources.profile && contribution.profile !== sources.profile) continue;
    layers.push(readComposition(contribution.patch, `profile:${contribution.profile}`));
  }

  if (sources.home && fs.existsSync(sources.home)) layers.push(readComposition(sources.home, 'home'));
  if (sources.overlay?.length) layers.push({ source: 'cli', entries: sources.overlay });

  return { entries: compose(layers), layers };
}

/** How a row's module is turned into a plugin. Injectable, so tests need no packages on disk. */
export type Importer = (name: string) => Promise<unknown>;

export interface MountOptions {
  import?: Importer;
  /** The one human decision used for external plugins that can reach ctx.tools. */
  toolReview?: AttendedPluginReview;
}

const defaultImporter: Importer = name => import(name);

/** The specifier a group row uses, matching dsh. */
export const GROUP = 'cordis:group';

/**
 * Mount a resolved tree onto a context.
 *
 * A group row becomes a child context with its isolations applied, and its
 * children mount inside it — which is how one agent gets its own terminal
 * registry without the rest of the tree seeing it.
 *
 * @param ctx — the context to mount into.
 * @param entries — the resolved rows.
 * @param options — a custom importer, for tests and for bundled plugins.
 * @returns the ids that mounted, in order.
 */
export async function mount(
  ctx: Context,
  entries: readonly Entry[],
  options: MountOptions = {},
): Promise<string[]> {
  const load = options.import ?? defaultImporter;
  const mounted: string[] = [];

  for (const entry of entries) {
    if (entry.disabled) continue;

    if (entry.group || entry.name === GROUP) {
      let child = ctx.extend({});
      for (const service of Object.keys(entry.isolate ?? {})) {
        if (entry.isolate?.[service]) child = child.isolate(service);
      }
      mounted.push(entry.id);
      mounted.push(...await mount(child, (entry.config as Entry[]) ?? [], options));
      continue;
    }

    const module: any = await load(entry.name);
    const plugin = module?.default ?? module;
    if (!plugin || (typeof plugin !== 'function' && typeof plugin.apply !== 'function')) {
      throw new Error(`"${entry.name}" (entry "${entry.id}") is not a plugin`);
    }
    // `mount` is the package installation boundary. Flyt's own logical
    // `flyt:*` rows are composition, not third-party installs; every external
    // plugin that asks for the tools seam goes through the attended review.
    // With no reviewer (the Loop profile), refusal happens before apply().
    const injected = pluginInjections(plugin.inject);
    if (!entry.name.startsWith('flyt:') && injected.includes('tools')) {
      await installPlugin(ctx, plugin, options.toolReview, entry.config);
    } else {
      await ctx.plugin(plugin, entry.config as any);
    }
    mounted.push(entry.id);
  }

  return mounted;
}

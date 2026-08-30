/**
 * The managed side of Flyt's Cordis plugin tree.
 *
 * Cordis owns execution, dependency injection and cleanup. This host owns the
 * application concerns Cordis deliberately does not: stable composition ids,
 * logical module resolution, batch rollback, a catalog, and addressing one
 * installed fiber for update/restart/uninstall.
 *
 * @module #kernel/loader/host
 */
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { Entry } from './compose.js';
import {
  GROUP, type Importer, type MountOptions,
} from './index.js';
import { installPlugin } from '../plugins/tools.js';
import { installTrustedPlugin } from '../plugins/trusted-install.js';
import { builtinImporter, builtinMetadata, isBuiltin } from '../profiles.js';

/**
 * What one installed row is doing.
 *
 * `pending` is Cordis's own: a fiber whose injected services are not all there
 * yet. `failed` is this host's: a lifecycle call that threw. A plugin whose
 * `configure` rejected is still mounted and still the old fiber, and reporting
 * it as `active` would make the manager say the new configuration took.
 */
export type PluginState = 'active' | 'pending' | 'failed';

/** Cloneable facts about one installed composition row. */
export interface InstalledPlugin {
  id: string;
  /** Cordis/plugin display name. */
  name: string;
  /** Import specifier written in the composition row. */
  specifier: string;
  description: string;
  source: string;
  contributes: string[];
  inject: string[];
  builtin: boolean;
  group: boolean;
  parentId: string | null;
  installed: true;
  state: PluginState;
  /** Why the last lifecycle call failed. Present only while `state` is `failed`. */
  error?: string;
  config?: unknown;
}

interface MountedNode {
  entry: Entry;
  public: InstalledPlugin;
  fiber?: Fiber;
  children: MountedNode[];
}

function pluginObject(module: any): any {
  return module?.default ?? module;
}

function pluginInject(plugin: any, entry: Entry): string[] {
  const declared = plugin?.inject ?? entry.inject;
  if (Array.isArray(declared)) return declared.map(String);
  if (declared && typeof declared === 'object') return Object.keys(declared);
  return [];
}

function stringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

// Cordis exposes FiberState as an ambient const enum; verbatim-module builds
// cannot import it at runtime. PENDING is its documented zero value.
const isPending = (fiber: Fiber): boolean => fiber.state === 0;

async function disposeNode(node: MountedNode): Promise<void> {
  for (const child of [...node.children].reverse()) await disposeNode(child);
  await node.fiber?.dispose();
}

/** A persistent, addressable view over Cordis fibers mounted on one root. */
export class PluginHost {
  private nodes = new Map<string, MountedNode>();
  private roots: MountedNode[] = [];
  private listeners = new Set<() => void>();

  constructor(private ctx: Context) {}

  /** Install a batch. If any row fails, everything mounted by this batch goes. */
  async install(entries: readonly Entry[], options: MountOptions = {}): Promise<string[]> {
    const load = options.import ?? ((name: string) => isBuiltin(name) ? builtinImporter(name) : import(name));
    const batchIds = new Set<string>();
    const mounted: MountedNode[] = [];

    const mountRows = async (parent: Context, rows: readonly Entry[], parentId: string | null): Promise<MountedNode[]> => {
      const result: MountedNode[] = [];
      for (const entry of rows) {
        if (entry.disabled) continue;
        if (!entry.id) throw new Error('every plugin entry needs an id');
        if (this.nodes.has(entry.id) || batchIds.has(entry.id)) {
          throw new Error(`A plugin entry named "${entry.id}" is already installed`);
        }
        batchIds.add(entry.id);

        if (entry.group || entry.name === GROUP) {
          let childContext = parent.extend({});
          for (const service of Object.keys(entry.isolate ?? {})) {
            if (entry.isolate?.[service]) childContext = childContext.isolate(service);
          }
          const node: MountedNode = {
            entry: { ...entry },
            children: [],
            public: {
              id: entry.id, name: entry.id, specifier: GROUP,
              description: 'A scoped group of plugins.', source: (entry as any).from ?? 'runtime',
              contributes: [], inject: [], builtin: true, group: true,
              parentId, installed: true, state: 'active', config: entry.config,
            },
          };
          result.push(node);
          mounted.push(node);
          node.children = await mountRows(childContext, (entry.config as Entry[]) ?? [], entry.id);
          continue;
        }

        const bundled = isBuiltin(entry.name);
        // Import executes top-level code. Refuse external code before import if
        // this surface cannot present the mandatory classification pass.
        if (!bundled && (!options.toolReview?.attended || typeof options.toolReview.decide !== 'function')) {
          throw new Error('Refused: installing a tool-capable plugin requires an attended human classification review');
        }
        const module: any = await (bundled ? builtinImporter(entry.name) : load(entry.name));
        const plugin = pluginObject(module);
        if (!plugin || (typeof plugin !== 'function' && typeof plugin.apply !== 'function')) {
          throw new Error(`"${entry.name}" (entry "${entry.id}") is not a plugin`);
        }
        const meta = bundled ? builtinMetadata(entry.name) : null;
        const fiber = bundled
          ? await installTrustedPlugin(parent, plugin, entry.config)
          : await installPlugin(parent, plugin, options.toolReview, entry.config);
        const state: PluginState = isPending(fiber) ? 'pending' : 'active';
        const node: MountedNode = {
          entry: { ...entry }, fiber, children: [],
          public: {
            id: entry.id,
            name: String(meta?.name ?? plugin.name ?? entry.name),
            specifier: entry.name,
            description: String(module?.description ?? plugin.description ?? meta?.description ?? ''),
            source: (entry as any).from ?? (bundled ? 'bundled' : 'runtime'),
            contributes: stringList(meta?.contributes ?? module?.contributes ?? plugin.contributes),
            inject: pluginInject(plugin, entry),
            builtin: bundled, group: false, parentId, installed: true, state,
            ...(entry.config === undefined ? {} : { config: entry.config }),
          },
        };
        result.push(node);
        mounted.push(node);
      }
      return result;
    };

    try {
      const roots = await mountRows(this.ctx, entries, null);
      for (const node of mounted) this.nodes.set(node.public.id, node);
      this.roots.push(...roots);
      if (mounted.length) this.emit();
      return mounted.map(node => node.public.id);
    } catch (error) {
      for (const node of [...mounted].reverse()) {
        // A child is also reached through its group. Disposing fibers is
        // idempotent, and the explicit reverse pass also covers a half-built
        // group whose child list was not assigned yet.
        await node.fiber?.dispose();
      }
      throw error;
    }
  }

  /** Detached, cloneable catalog in installation/tree order. */
  list(): InstalledPlugin[] {
    const out: InstalledPlugin[] = [];
    const visit = (node: MountedNode) => {
      out.push({ ...node.public, contributes: [...node.public.contributes], inject: [...node.public.inject] });
      for (const child of node.children) visit(child);
    };
    for (const root of this.roots) visit(root);
    return out;
  }

  get(id: string): InstalledPlugin | undefined {
    const found = this.nodes.get(id)?.public;
    return found ? { ...found, contributes: [...found.contributes], inject: [...found.inject] } : undefined;
  }

  /**
   * Run one lifecycle call, and record what it did to the row either way.
   *
   * A rejection that only propagated would leave the catalog claiming the row
   * is fine, because nothing about a failed `update` changes what `list()`
   * reports. The caller still gets the error — this only makes sure the next
   * reader of the catalog is told the same thing.
   */
  private async lifecycle(node: MountedNode, act: () => Promise<void>): Promise<void> {
    try {
      await act();
      node.public.state = node.fiber && isPending(node.fiber) ? 'pending' : 'active';
      delete node.public.error;
    } catch (error) {
      node.public.state = 'failed';
      node.public.error = String((error as Error)?.message ?? error);
      throw error;
    } finally {
      this.emit();
    }
  }

  async configure(id: string, config: unknown): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`There is no installed plugin entry named "${id}"`);
    if (!node.fiber) throw new Error(`Plugin group "${id}" is configured through its child rows`);
    await this.lifecycle(node, async () => {
      await node.fiber!.update(config);
      node.entry.config = config as any;
      node.public.config = config;
    });
  }

  async restart(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`There is no installed plugin entry named "${id}"`);
    if (!node.fiber) throw new Error(`Plugin group "${id}" has no executable fiber`);
    await this.lifecycle(node, () => node.fiber!.restart());
  }

  async uninstall(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`There is no installed plugin entry named "${id}"`);
    await disposeNode(node);
    const remove = (current: MountedNode) => {
      this.nodes.delete(current.public.id);
      for (const child of current.children) remove(child);
    };
    remove(node);
    if (node.public.parentId) {
      const parent = this.nodes.get(node.public.parentId);
      if (parent) parent.children = parent.children.filter(child => child !== node);
    } else {
      this.roots = this.roots.filter(root => root !== node);
    }
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.nodes.clear();
    this.roots = [];
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

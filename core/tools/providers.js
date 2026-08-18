// Providers: how a tool DEFINITION becomes something runnable.
//
// Each provider exports { kind, load(def) } and returns the run(args, ctx)
// function for that definition — or throws with a reason, which the registry
// records as a load failure so the tool resolves as missing instead of
// crashing a run (DESIGN-SPEC.md §5).
//
// Only `builtin` is implemented today. `http`, `mcp` and `flow` are listed so
// an imported definition naming one fails with
// an honest "not available yet" rather than "unknown provider".
import { builtinModule } from './builtins.js';

const notYet = kind => ({
  kind,
  load() { throw new Error(`the "${kind}" provider is not available yet`); }
});

export const PROVIDERS = {
  builtin: {
    kind: 'builtin',
    load(def) {
      const mod = builtinModule(def.id);
      if (!mod) throw new Error(`no built-in module named "${def.id}" — the definition names a tool this build does not ship`);
      return mod.run.bind(mod);
    }
  },
  http: notYet('http'),
  mcp: notYet('mcp'),
  flow: notYet('flow')
};

export const getProvider = kind => PROVIDERS[kind] ?? null;

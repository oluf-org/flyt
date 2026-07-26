// Providers: how a tool DEFINITION becomes something runnable.
//
// Each provider exports { kind, load(def) } and returns the run(args, ctx)
// function for that definition — or throws with a reason, which the registry
// records as a load failure so the tool resolves as missing instead of
// crashing a run (TOOLS-PLAN §5).
//
// Only `builtin` is implemented today. `http` (P5), `mcp` (P6) and `flow`
// (reserved, §9.4) are listed so an imported definition naming one fails with
// an honest "not available yet" rather than "unknown provider".
import { builtinModule } from './builtins.js';

const notYet = (kind, phase) => ({
  kind,
  load() { throw new Error(`the "${kind}" provider is not available yet (TOOLS-PLAN ${phase})`); }
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
  http: notYet('http', 'P5'),
  mcp: notYet('mcp', 'P6'),
  flow: notYet('flow', '§9.4')
};

export const getProvider = kind => PROVIDERS[kind] ?? null;

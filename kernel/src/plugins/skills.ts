/**
 * `flyt-skills` — the skill provider registry, in dsh's shape.
 *
 * Not one of the eight capability seams: this is the service definition dsh's
 * skill packages register into, implemented here so a real published skill
 * provider loads against Flyt unmodified (D54). Ours merges provider catalogs,
 * resolves a name to a winner, and loads bodies on demand — the same three
 * jobs, without the scoping and caching layers dsh's registry carries.
 *
 * Where Flyt's own skills (D15, `.flyt/skills/`) meet this registry is a Phase
 * 4 question, along with skills that *request* tools (D58). Phase 0 needs one
 * thing from it: that the contract is real, and a plugin written against it
 * works here.
 *
 * @module #kernel/plugins/skills
 */
import { Service, type Context } from '@deepseek-ai/cordis';

/** Where a skill came from. Prompt-visible metadata, not precedence. */
export type SkillSource = 'bundled' | 'project' | 'user' | 'runtime' | (string & {});

/** How a loaded body resolves relative resources. */
export type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string };

/** Who may reach a skill. */
export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
}

/** What a catalog lists. */
export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: SkillInvocationPolicy;
  readonly source: SkillSource;
  readonly provider: string;
  readonly resourceBase?: SkillResourceBase;
}

/** A catalog entry, with what the provider needs to load it later. */
export interface SkillCandidate extends SkillSummary {
  /** Lower wins a duplicate name; registration order breaks a tie. */
  readonly rank: number;
  /** Opaque, handed back to the provider's `get()`. */
  readonly locator: unknown;
  readonly path?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A skill with its body. */
export interface SkillDefinition extends SkillSummary {
  readonly content: string;
  readonly path?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** One source of skills. */
export interface SkillProvider {
  readonly name: string;
  list(options?: unknown): Promise<readonly SkillCandidate[]>;
  get(candidate: SkillCandidate, options?: unknown): Promise<SkillDefinition | undefined>;
}

/** Handed to a provider factory so it can withdraw or refresh itself. */
export interface SkillProviderControl {
  /** Aborts when this registration is disposed. */
  readonly signal: AbortSignal;
  /** Tell the registry this provider's catalog changed. */
  readonly invalidate: () => void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    skills: SkillsService;
  }
}

/** Cordis plugin name. */
export const name = 'flyt-skills';

interface Registration {
  provider: SkillProvider;
  controller: AbortController;
  /** Registration order, breaking a rank tie. */
  order: number;
}

/**
 * The registry.
 *
 * A Cordis `Service` rather than a plain object, and that is not decoration:
 * cordis hands each consumer a context-bound view, so `this.ctx` inside a
 * method is the CALLER's context. That is what lets a registration be owned by
 * the fiber that made it — and it is what dsh's own registries rely on. The
 * published `dsh-skill-badge` plugin calls `registerProvider()` and does not
 * return the disposer; without caller-owned registration its provider would
 * outlive the plugin, and unloading a plugin would leave its skills in the
 * catalog forever.
 */
export class SkillsService extends Service {
  // Ordinary private fields, not `#private` ones. Cordis derives a per-caller
  // view with `Object.create(this)`, and a `#private` field is not reachable
  // through a derived object — the first call from a plugin dies with "cannot
  // read private member from an object whose class did not declare it". Every
  // service on this contract has to be written this way.
  private registrations = new Set<Registration>();
  private order = 0;

  constructor(ctx: Context) {
    super(ctx, 'skills');
  }

  /**
   * Register a provider, owned by the calling plugin's fiber.
   *
   * The factory runs synchronously; discovery, authentication and anything
   * else slow belongs in the provider's `list()`, which is why registration
   * cannot fail halfway and leave a half-registered source behind.
   *
   * @param create — factory receiving this registration's lifecycle control.
   * @returns a disposer that unregisters the provider early.
   */
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void {
    const controller = new AbortController();
    const provider = create({ signal: controller.signal, invalidate: () => { /* nothing is cached yet */ } });
    if (!provider?.name) throw new Error('A skill provider needs a name');
    for (const existing of this.registrations) {
      if (existing.provider.name === provider.name) {
        throw new Error(`A skill provider named "${provider.name}" is already registered`);
      }
    }
    const registration: Registration = { provider, controller, order: this.order++ };
    const registrations = this.registrations;
    // Owned by the caller's fiber: when the plugin unloads, so does this.
    return this.ctx.effect(() => {
      registrations.add(registration);
      return () => {
        registrations.delete(registration);
        controller.abort();
      };
    }) as () => void;
  }

  /** Every candidate, best first: lower rank wins, then earlier registration. */
  private async candidates(options?: unknown): Promise<SkillCandidate[]> {
    const all: { candidate: SkillCandidate; registration: Registration }[] = [];
    for (const registration of this.registrations) {
      // A provider that throws is a broken source, not a broken registry: the
      // others still answer, and the failure is visible in the log rather than
      // in an empty catalog nobody can explain.
      let listed: readonly SkillCandidate[] = [];
      try { listed = await registration.provider.list(options); }
      catch (err) {
        this.ctx.logger('skills').warn(`provider "${registration.provider.name}" failed to list: ${String(err)}`);
      }
      for (const candidate of listed) all.push({ candidate, registration });
    }
    all.sort((a, b) =>
      (a.candidate.rank - b.candidate.rank)
      || (a.registration.order - b.registration.order)
      || a.candidate.name.localeCompare(b.candidate.name));

    const winners = new Map<string, SkillCandidate>();
    for (const { candidate } of all) if (!winners.has(candidate.name)) winners.set(candidate.name, candidate);
    return [...winners.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The merged catalog, one winner per name, sorted by name. */
  async list(options?: unknown): Promise<SkillSummary[]> {
    return (await this.candidates(options)).map(({ rank, locator, ...summary }) => summary);
  }

  /** One skill, body included, or undefined if no provider has it. */
  async get(skillName: string, options?: unknown): Promise<SkillDefinition | undefined> {
    const candidate = (await this.candidates(options)).find(c => c.name === skillName);
    if (!candidate) return undefined;
    for (const registration of this.registrations) {
      if (registration.provider.name !== candidate.provider) continue;
      return registration.provider.get(candidate, options);
    }
    return undefined;
  }
}

/**
 * Provide `ctx.skills`.
 *
 * @param ctx — the context to provide in.
 */
export function apply(ctx: Context): void {
  new SkillsService(ctx);
}

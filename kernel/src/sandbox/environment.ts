const SECRET_NAME = /(KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL)/i;

/** Parent process environment with ambient credentials and Flyt authority removed. */
export function scrubbedParentEnv(
  parent: NodeJS.ProcessEnv = process.env,
  forwardedNames: readonly string[] = [],
): Record<string, string> {
  const forwarded = new Set(forwardedNames.map(name => process.platform === 'win32' ? name.toUpperCase() : name));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    if (/^FLYT_/i.test(name)) continue;
    if (SECRET_NAME.test(name) && !forwarded.has(key)) continue;
    out[name] = value;
  }
  return out;
}

export function layeredEnv(
  base: Readonly<Record<string, string | undefined>>,
  ...layers: readonly Readonly<Record<string, string | undefined>>[]
): Record<string, string> {
  const out: Record<string, string> = {};
  const actual = new Map<string, string>();
  const apply = (layer: Readonly<Record<string, string | undefined>>) => {
    for (const [name, value] of Object.entries(layer)) {
      const key = process.platform === 'win32' ? name.toUpperCase() : name;
      const previous = actual.get(key);
      if (previous) delete out[previous];
      actual.delete(key);
      if (value !== undefined) { out[name] = value; actual.set(key, name); }
    }
  };
  apply(base);
  for (const layer of layers) apply(layer);
  return out;
}

export const isCredentialEnvName = (name: string): boolean => SECRET_NAME.test(name) || /^FLYT_/i.test(name);

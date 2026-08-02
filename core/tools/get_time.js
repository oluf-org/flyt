// get_time: what time is it (TOOLS-PLAN §14.4).
//
// Trivially small, and worth stating why it earns a place in the catalog:
// models are systematically wrong about the current date — they answer from
// training data, confidently. It is also the canonical demonstration that a
// grant should be NARROW: a node that needs to know the date needs a clock,
// not a network.
export default {
  name: 'get_time',
  title: 'Current date and time',
  description: 'The current date and time — ISO 8601 (UTC), the local formatted time, the IANA timezone, and the Unix epoch in seconds. Use this instead of assuming today\'s date.',
  effects: ['read'],
  scope: 'run',
  risk: 'safe',
  autoExecute: true,
  keywords: ['time', 'date', 'now', 'today', 'clock', 'timestamp', 'timezone'],
  examples: ['what is today\'s date', 'timestamp this release note'],
  result: { preview: 'json', maxPreviewChars: 500, artifact: true },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      timezone: { type: 'string', description: 'Optional IANA timezone for the local rendering, e.g. "Europe/Oslo". Defaults to this machine\'s zone.' }
    }
  },
  run(args) {
    const now = new Date();
    const timezone = args?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    let local;
    try {
      local = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, dateStyle: 'full', timeStyle: 'long'
      }).format(now);
    } catch {
      throw new Error(`Unknown timezone "${timezone}". Use an IANA name like "Europe/Oslo", or omit it.`);
    }
    return {
      iso: now.toISOString(),
      local,
      timezone,
      unix: Math.floor(now.getTime() / 1000)
    };
  }
};

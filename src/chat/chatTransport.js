// One door to the chat IPC, addressed by CHANNEL.
//
// Every surface that shows a chat talks to the same six verbs. What differs is
// WHICH conversation it is addressing, and that address rides on every call
// rather than being implied by whichever component happened to make it. A
// thread list that silently belonged to whoever asked last is the bug this
// exists to make impossible.
//
// `onChatEvent` is one stream carrying every channel's tokens, so the filter
// lives here: a surface subscribes to its own channel and never sees another's.
//
// The host is injected so a test can hand in a plain object. The renderer
// cannot reach the chat store directly — this is the only door.

/** The channels the main process will answer for. */
export const CHAT_CHANNELS = ['loop', 'build'];

export const DEFAULT_CHANNEL = 'loop';

/** The channel an event belongs to. Old events carry none and are the loop's. */
export const channelOf = event => {
  const named = event?.channel;
  return CHAT_CHANNELS.includes(named) ? named : DEFAULT_CHANNEL;
};

/**
 * The transport for one channel.
 *
 * @param channel — 'loop' | 'build'. Anything else is the loop, because an
 *   unknown channel must not invent a second store on disk.
 * @param host — `window.flyt`, or anything with the same shape.
 */
export function chatTransport(channel, host = globalThis.window?.flyt ?? null) {
  const scope = CHAT_CHANNELS.includes(channel) ? channel : DEFAULT_CHANNEL;
  const call = (name, ...args) => {
    const fn = host?.[name];
    if (typeof fn !== 'function') return Promise.reject(new Error(`This host cannot ${name}.`));
    return Promise.resolve(fn.call(host, ...args));
  };
  return {
    channel: scope,
    available: typeof host?.chatSend === 'function',
    threads: projectId => call('chatThreads', projectId, scope),
    read: (projectId, threadId) => call('chatRead', projectId, threadId, scope),
    create: projectId => call('chatNew', projectId, scope),
    send: (projectId, threadId, text, worker) => call('chatSend', projectId, threadId, text, worker, scope),
    stop: (projectId, threadId) => call('chatStop', projectId, threadId, scope),
    remove: (projectId, threadId) => call('chatDelete', projectId, threadId, scope),
    /** Live tokens and tool calls for THIS channel only. */
    subscribe(listener) {
      if (typeof host?.onChatEvent !== 'function') return () => {};
      return host.onChatEvent(event => { if (channelOf(event) === scope) listener(event); });
    },
    // The model this person already chose, per channel. `chat.worker` is read
    // as the loop's because that is where the single-channel version wrote it;
    // everything written from here on is keyed by channel, so Build choosing a
    // cheap model does not silently re-point the Loop's chat at it.
    readWorker: async () => {
      try {
        const settings = await call('getSettings');
        return settings?.chat?.workers?.[scope]
          ?? (scope === DEFAULT_CHANNEL ? settings?.chat?.worker ?? null : null);
      } catch { return null; }
    },
    saveWorker: worker => call('setSettings', { chat: { workers: { [scope]: worker } } }),
  };
}

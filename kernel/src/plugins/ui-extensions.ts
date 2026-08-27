/**
 * The plugin-to-host UI declaration boundary (D61).
 *
 * This is a Cordis service, not a renderer registry. A plugin sends a typed
 * `ui.contribute` request through its context-bound service view. The service
 * derives the plugin identity from that calling fiber, validates and clones
 * the declaration, and owns it with the fiber. Hosts may list the resulting
 * data; no plugin JavaScript or component ever crosses into the renderer.
 *
 * @module #kernel/plugins/ui-extensions
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '../types.js';
import {
  assertUiExtensionRpcRequest,
  type UiContributionRecord,
  type UiExtensionRpc,
  type UiExtensionRpcRequest,
  type UiExtensionRpcResponse,
} from '../seams/ui-extensions.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    uiExtensions: UiExtensionRpc;
  }
}

/** Cordis plugin name. */
export const name = 'flyt-ui-extensions';

export class UiExtensionRegistry extends Service implements UiExtensionRpc {
  private registered = new Map<string, UiContributionRecord>();

  constructor(ctx: Context) {
    super(ctx, 'uiExtensions');
  }

  invoke(request: UiExtensionRpcRequest): UiExtensionRpcResponse {
    try {
      assertUiExtensionRpcRequest(request);
      if (request.method === 'ui.list') {
        const point = request.params.point;
        const rows = [...this.registered.values()].filter(row => !point || row.contribution.point === point);
        return { ok: true, result: structuredClone(rows) as unknown as JsonValue };
      }

      const pluginId = this.ctx.fiber.name;
      if (pluginId === 'root') throw new Error('ui.contribute must be called by an installed plugin');
      const contribution = structuredClone(request.params.contribution);
      const key = `${pluginId}\u0000${contribution.id}`;
      if (this.registered.has(key)) {
        throw new Error(`plugin "${pluginId}" already contributed UI id "${contribution.id}"`);
      }
      const row: UiContributionRecord = { pluginId, contribution };
      const registered = this.registered;
      const ctx = this.ctx;
      ctx.effect(() => {
        registered.set(key, row);
        ctx.emit('ui-extensions/change');
        return () => {
          if (registered.get(key) !== row) return;
          registered.delete(key);
          ctx.emit('ui-extensions/change');
        };
      });
      return { ok: true, result: { accepted: true, pluginId } };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      return {
        ok: false,
        error: {
          code: message.startsWith('Unknown UI RPC method') ? 'METHOD_NOT_FOUND' : 'INVALID_UI_CONTRIBUTION',
          message,
        },
      };
    }
  }
}

/** Provide the host boundary. */
export function apply(ctx: Context): void {
  new UiExtensionRegistry(ctx);
}

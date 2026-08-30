# Plugin system

Flyt uses Cordis for dependency injection, plugin lifecycle, scoped services,
and cleanup. Flyt's `PluginHost` adds the application-level pieces around it:
stable composition ids, logical module specifiers, package discovery, batch
rollback, an installed-plugin catalog, and addressed configure/restart/uninstall
operations.

## Author a plugin

A plugin is an ESM module in any Cordis-supported shape. The object form makes
the contract especially clear:

```js
export const name = 'example-blocks';
export const inject = ['blocks'];

export function apply(ctx, config = {}) {
  ctx.blocks.register({
    use: 'example-blocks:summarize',
    title: 'Summarize',
    description: 'Summarize the incoming artifact.',
    category: 'transformation',
    settings: { type: 'object', additionalProperties: false, properties: {} },
    ceiling: [],
    async execute(run) {
      return { status: 'done', output: `${config.prefix ?? ''}${run.input}` };
    },
  });
}
```

Registrations made through Flyt services are owned by the plugin's Cordis
fiber. They disappear automatically when the plugin is restarted, uninstalled,
or when the kernel shuts down.

## Declare installation

Flyt reads the same `dsh.bundle` and `dsh.profile` package metadata as the dsh
loader. A package can contribute a composition file from `package.json`:

```json
{
  "name": "example-flyt-plugin",
  "type": "module",
  "exports": "./index.js",
  "dsh": { "bundle": "./cordis.yml" }
}
```

`cordis.yml` names the importable package and gives the installation a stable
id. The id, rather than the module path, is what later patches and lifecycle
operations address:

```yaml
- id: example-blocks
  name: example-flyt-plugin
  config:
    prefix: "Summary: "
```

The desktop discovers contributing packages in its installed `node_modules`
and applies `~/.flyt/cordis.patch.yml` as the machine-level patch. That patch
can change one config field, disable a row, or add another importable plugin:

```yaml
- id: example-blocks
  name: example-flyt-plugin
  config:
    prefix: "Result: "
```

Composition order is package bundles, the selected Flyt profile, matching
profile patches, the home patch, then a runtime overlay. Later layers patch by
id. Built-ins use stable `flyt:*` specifiers and are resolved only by Flyt's
own importer; an external module cannot claim a trusted built-in name.

## Use and manage plugins

Application code installs logical rows through the booted kernel, including
runtime-configured built-ins:

```js
await booted.install([{
  id: 'workspace-fs',
  name: BUILTIN.fs,
  config: { root: workspaceDir },
}]);
```

The managed catalog is available through `booted.plugins`:

```js
booted.plugins.list();
await booted.plugins.configure('example-blocks', { prefix: 'New: ' });
await booted.plugins.restart('example-blocks');
await booted.plugins.uninstall('example-blocks');
```

Consumers do not import plugin implementations. They inject and use the
service contract (`ctx.blocks`, `ctx.tools`, `ctx.skills`, and the typed seams)
or resolve a contributed block by its stable `plugin:block` id. The Build
Library is projected from this same managed catalog.

External packages always cross the attended installation boundary before
their top-level module is imported. Any contributed tools are quarantined,
conservatively inferred, and shown in one host-rendered classification pass.
An unattended Loop worker refuses external package installation before import.
Classification still does not grant execution; block ceilings and the approval
gate remain separate requirements.

## The plugin manager

The desktop's own reader of that catalog is the **Library** destination:
`Library → Plugins`. It is a list and a detail pane, and it exists because
`booted.plugins` had four verbs that no surface could reach.

| Renderer | Responsibility |
| --- | --- |
| `src/v2/pluginManager.js` | Every judgement — status, provenance, which verbs a row gets, what a removal costs. Pure, so the safety line is testable. |
| `src/v2/PluginManager.jsx` | The list, the detail pane, the configuration editor, and the removal confirmation. |
| `src/v2/LibraryPage.jsx` | The destination: the six-kind catalog and the manager, as two views of one question. |

Three rules the surface holds to:

**Both halves, or it is not a change.** Every verb moves the live Cordis fiber
*and* `~/.flyt/cordis.patch.yml` (`core/pluginPatch.js`). A runtime-only
uninstall is undone by the next restart. Removal is two edits depending on
provenance: a row this machine's patch introduced is deleted, and a row a
bundle or profile composed is `disabled: true`, because the home layer can
patch a row it does not own but cannot delete one.

**Flyt's own services are inspect-only.** `builtin` rows are the block
registry, the tool gate and the approval policy; restarting one disposes the
check every running block goes through. The manager offers them no verbs, and
`electron/main.js` refuses them at the IPC boundary rather than trusting that
the only caller is a screen that already checked. A group is refused too: it
has no fiber of its own, and it is changed through the rows inside it.

**States are named, not spun.** `active`, `pending` and `failed` each get a
sentence. `pending` is Cordis's own — a fiber held until every service it
injects exists — so the pane names those services instead of showing a
spinner. `failed` carries the error from the lifecycle call that produced it.

Plugin-authored UI is unaffected by any of this: a plugin's `library-entry`
declarations render inside its own detail pane through
`PluginContributionView.jsx`, under the same closed vocabulary as everywhere
else. See [plugin-ui-extensions.md](plugin-ui-extensions.md).

The one required classification pass (`PluginTrustReview.jsx`) is rendered at
the **shell root**, not under a destination: installation can publish a review
while somebody is on Work, and a modal that exists on one surface is a modal an
installation can park behind.

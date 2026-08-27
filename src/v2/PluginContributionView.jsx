// Flyt-owned renderer for D61 declarations. A plugin can select only nodes in
// the closed vocabulary already accepted by the host RPC boundary; it cannot
// provide a React component, HTML, classes, styles, or callbacks.
import React from 'react';

export function FlytUiNode({ node }) {
  switch (node.component) {
    case 'text': return <p>{node.text}</p>;
    case 'code': return <pre><code>{node.text}</code></pre>;
    case 'badge': return <span className={`plugin-ui-badge tone-${node.tone ?? 'neutral'}`}>{node.text}</span>;
    case 'notice': return <aside className={`plugin-ui-notice tone-${node.tone ?? 'info'}`} role="note">{node.text}</aside>;
    case 'key-value': return <dl className="plugin-ui-key-value"><dt>{node.label}</dt><dd>{node.value}</dd></dl>;
    case 'stack': return <div className="plugin-ui-stack">{(node.children ?? []).map((child, index) => <FlytUiNode node={child} key={index} />)}</div>;
    default: return null; // unreachable: the non-renderer boundary rejects it.
  }
}

/** Flyt form controls generated from the contributed configuration schema. */
export function BlockConfigurationView({ contribution, value = {}, onChange = null }) {
  const set = (name, next) => onChange({ ...value, [name]: next });
  return <fieldset className="plugin-block-configuration">
    {Object.entries(contribution.schema.properties).map(([name, field]) => <label key={name}>
      <span>{field.title}</span>
      {field.description && <small>{field.description}</small>}
      {field.type === 'boolean' ? <input type="checkbox" checked={Boolean(value[name] ?? field.default)} disabled={!onChange} onChange={event => set(name, event.target.checked)} />
        : field.type === 'select' ? <select value={value[name] ?? field.default ?? ''} disabled={!onChange} required={contribution.schema.required?.includes(name)} onChange={event => set(name, event.target.value)}>
          {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
        </select>
          : <input type={field.type === 'number' ? 'number' : 'text'} value={value[name] ?? field.default ?? ''}
            disabled={!onChange} required={contribution.schema.required?.includes(name)}
            onChange={event => set(name, field.type === 'number' ? event.target.valueAsNumber : event.target.value)} />}
    </label>)}
  </fieldset>;
}

/** Tool results are data supplied by Flyt; the plugin only declared this view. */
export function ToolContributionView({ contribution, pluginId = null }) {
  return <section className="plugin-tool-view" data-plugin={pluginId ?? undefined} aria-label={`${contribution.tool} tool view`}>
    <FlytUiNode node={contribution.view} />
  </section>;
}

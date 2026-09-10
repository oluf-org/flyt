import React, { useEffect, useMemo, useRef, useState } from 'react';
import './assetStyles.css';

const drafts = new Map();
function draftFor(key) {
  if (!drafts.has(key)) {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(`flyt.assets.draft.${key}`)); } catch { /* fresh draft */ }
    drafts.set(key, { text: '', attachments: [], requestId: crypto.randomUUID(), draftId: crypto.randomUUID(), ...saved, pending: 0, sending: false, errors: [] });
  }
  return drafts.get(key);
}
export function adoptAssetDraft(from, to) { if (drafts.has(from)) drafts.set(to, drafts.get(from)); }
export function useAssetDraft(key, projectId, onSubmit) {
  const draft = useMemo(() => draftFor(key), [key]);
  const [, render] = useState(0);
  const notify = () => {
    const { text, attachments, requestId, draftId } = draft;
    try { for (const [alias, value] of drafts) if (value === draft) sessionStorage.setItem(`flyt.assets.draft.${alias}`, JSON.stringify({ text, attachments, requestId, draftId })); } catch { /* keep in memory */ }
    render(value => value + 1);
  };
  const changed = () => { draft.requestId = crypto.randomUUID(); notify(); };
  const updateText = text => { draft.text = text; changed(); };
  const remove = id => { draft.attachments = draft.attachments.filter(asset => asset.assetId !== id); changed(); };
  const accept = asset => {
    if (draft.attachments.some(ref => ref.assetId === asset.assetId)) return;
    if (draft.attachments.length >= 10) throw new Error('Attach at most 10 images');
    if (draft.attachments.reduce((sum, ref) => sum + ref.byteLength, asset.byteLength) > 50 * 1024 ** 2) throw new Error('Attachments exceed 50 MiB');
    draft.attachments.push(asset); changed();
  };
  const importFiles = async files => {
    if (draft.sending) return;
    const selected = Array.from(files); if (!selected.length) return;
    draft.pending++; draft.errors = []; notify();
    for (const file of selected) {
      try {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Use PNG, JPEG, WebP, or static GIF');
        if (file.size > 20 * 1024 ** 2) throw new Error('Image exceeds 20 MiB');
        const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read image')); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(file); });
        accept(await window.flyt.importAsset({ projectId, draftId: draft.draftId, name: file.name, base64 }));
      } catch (error) { draft.errors.push(`${file.name}: ${error.message}`); }
    }
    draft.pending--; notify();
  };
  const pasteImage = async () => {
    if (draft.sending || draft.pending) return;
    draft.pending++; draft.errors = []; notify();
    try { accept(await window.flyt.pasteImage({ projectId, draftId: draft.draftId })); }
    catch (error) { draft.errors.push(error.message); }
    finally { draft.pending--; notify(); }
  };
  const submit = async () => {
    if (draft.sending || draft.pending || (!draft.text.trim() && !draft.attachments.length)) return;
    const submitted = { requestId: draft.requestId, text: draft.text.trim(), attachments: [...draft.attachments] };
    draft.sending = true; draft.errors = []; notify();
    try {
      const result = await onSubmit(submitted);
      if (result === false || result?.ok === false) throw new Error(result?.error ?? 'Message could not be sent');
      if (draft.requestId === submitted.requestId) { draft.text = ''; draft.attachments = []; changed(); }
    } catch (error) { draft.errors = [error.message]; }
    finally { draft.sending = false; notify(); }
  };
  const onPaste = event => {
    const files = [...event.clipboardData.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    const text = event.clipboardData.getData('text/plain');
    const target = event.target;
    if (text) updateText(draft.text.slice(0, target.selectionStart ?? draft.text.length) + text + draft.text.slice(target.selectionEnd ?? draft.text.length));
    void importFiles(files);
  };
  const [dragging, setDragging] = useState(false);
  const dropProps = {
    onPaste,
    onDragOver: event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.stopPropagation(); setDragging(true); } },
    onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); },
    onDrop: event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.stopPropagation(); setDragging(false); void importFiles(event.dataTransfer.files); } },
  };
  return { draft, updateText, remove, importFiles, pasteImage, submit, dropProps, dragging,
    canSend: !draft.pending && !draft.sending && Boolean(draft.text.trim() || draft.attachments.length) };
}

function AssetImage({ asset, projectId, full = false }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setUrl(null); setError('');
    window.flyt.previewAsset({ projectId: asset.draftId ? null : projectId, asset, full }).then(value => { if (active) setUrl(value.dataUrl); }, error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [asset.assetId, asset.draftId, projectId, full]);
  return error ? <span className="asset-error" role="alert">{error}</span> : url ? <img src={url} alt={full ? asset.name : ''} /> : <span>Loading…</span>;
}
export function AssetList({ assets = [], projectId, onRemove }) {
  const [preview, setPreview] = useState(null);
  const dialog = useRef(null);
  useEffect(() => { if (preview) dialog.current?.showModal(); }, [preview]);
  if (!assets.length) return null;
  return <><div className="asset-list">{assets.map(asset => <div className="asset-chip" key={asset.assetId}>
    <button type="button" className="asset-open" title={`Preview ${asset.name}`} onClick={() => setPreview(asset)}>
      {asset.kind === 'image' ? <AssetImage asset={asset} projectId={projectId}/> : <span aria-hidden="true">▧</span>}
      <span>{asset.name}</span>
    </button>{onRemove && <button type="button" className="asset-remove" aria-label={`Remove ${asset.name}`} onClick={() => onRemove(asset.assetId)}>×</button>}
  </div>)}</div>{preview && <dialog className="asset-preview" ref={dialog} onCancel={() => setPreview(null)} onClick={event => { if (event.target === event.currentTarget) setPreview(null); }}>
    <header><span>{preview.name} · {preview.width} × {preview.height}</span><button type="button" aria-label="Close preview" onClick={() => setPreview(null)}>×</button></header>
    <AssetImage asset={preview} projectId={projectId} full/>
  </dialog>}</>;
}
export function ContextAssets({ assets = [], projectId, label = 'Context assets' }) {
  const [open, setOpen] = useState(false);
  if (!assets.length) return null;
  return <details className="context-assets" onToggle={event => setOpen(event.currentTarget.open)} onClick={event => event.stopPropagation()}>
    <summary title="Assets available in this node’s input context. Model delivery is recorded in Inspect queries.">▧ {label} <span>{assets.length}</span></summary>
    {open && <AssetList assets={assets} projectId={projectId}/>}
  </details>;
}
export function AttachmentTools({ composer, projectId }) {
  const picker = useRef(null);
  return <div className="attachment-tools">
    <AssetList assets={composer.draft.attachments} projectId={projectId} onRemove={composer.draft.sending ? null : composer.remove}/>
    <div className="attachment-actions"><button type="button" disabled={composer.draft.sending || Boolean(composer.draft.pending)} onClick={() => picker.current.click()}>＋ Attach images</button>
      {typeof window !== 'undefined' && window.flyt?.pasteImage && <button type="button" disabled={composer.draft.sending || Boolean(composer.draft.pending)} onClick={composer.pasteImage}>Paste image</button>}
      {composer.draft.pending > 0 && <span role="status">Preparing images…</span>}
    </div>
    <input ref={picker} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { void composer.importFiles(event.target.files); event.target.value = ''; }}/>
    {composer.dragging && <div className="asset-drop-hint">Drop images here</div>}
    {composer.draft.errors.map((error, index) => <p role="alert" className="asset-error" key={index}>{error}</p>)}
  </div>;
}
export default function AssetComposer({ projectId, draftKey, onSubmit, placeholder, label = 'Send', busy = false }) {
  const composer = useAssetDraft(draftKey, projectId, onSubmit);
  return <form className="asset-composer" {...composer.dropProps} onSubmit={event => { event.preventDefault(); if (!busy) void composer.submit(); }}>
    <textarea rows={2} value={composer.draft.text} disabled={composer.draft.sending} placeholder={placeholder} aria-label={placeholder} onChange={event => composer.updateText(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void composer.submit(); } }}/>
    <AttachmentTools composer={composer} projectId={projectId}/>
    <button type="submit" disabled={busy || !composer.canSend}>{composer.draft.sending ? 'Sending…' : label}</button>
  </form>;
}

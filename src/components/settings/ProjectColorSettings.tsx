// Project color settings — the Settings page's Color section (per-project
// theming): the 9 template colors as one-click swatches plus a native custom
// color picker. There is no save step: a preset click or a committed picker
// value persists straight through the project color API, and the visible
// theme moves with it because the host merges the updated record into its
// projects state — which is exactly what the Shell's theme effect
// (src/v2/Shell.jsx → src/lib/applyProjectTheme.js) watches, so accents and
// the background tint re-derive with no reload.
//
// Nominal-vs-actual scope: the task names src/components/settings/
// ProjectColorSettings.tsx. The repo has no src/components/ tree (this is its
// first member) and its renderer modules are plain-JSX .jsx; the path is
// honored literally and the .tsx suffix costs nothing — vite's react plugin
// transpiles it exactly like the repo's .jsx files and no gate typechecks
// src/ (the Node gate never imports it; only vite does).
//
// Data flow (the repo's real one): `projects` is the listProjects payload the
// host already holds — registry.listOpen() tabs, each carrying the persisted
// `colorHex`. Persisting goes flyt.projectColor(id, hex) → IPC 'project:color'
// → registry.setColor → settings.json; the record that comes back is handed to
// onColorChange, whose host-side merge rethemes live. A record with no color
// is the auto-assigned case: the registry assigns one at open, and this
// section reads it back rather than inventing a value here.
import React, { useEffect, useRef, useState } from 'react';
import { PRESET_PROJECT_COLORS, normalizeHexColor } from '../../lib/projectTheme.js';
import { DEFAULT_PROJECT_COLOR_HEX } from '../../lib/applyProjectTheme.js';
import './projectColorSettings.css';

/** One open project tab, the shape registry.listOpen() ships to the renderer. */
interface ProjectTabRecord {
  id?: string;
  name?: string;
  colorHex?: string | null;
  color?: string | null;
  [key: string]: unknown;
}

interface ProjectsPayload {
  tabs?: ProjectTabRecord[];
  active?: string | null;
}

/** The slice of window.flyt this section calls (preload.cjs / devMock). */
interface ProjectColorApi {
  projectColor?: (projectId: string, hex?: string | null) => Promise<{
    id?: string;
    name?: string;
    colorHex?: string | null;
  }>;
}

interface ProjectColorSettingsProps {
  projects?: ProjectsPayload | null;
  /** Called with the updated tab record; the host's state merge is the live re-theme. */
  onColorChange?: (project: ProjectTabRecord) => void;
  /** Injectable flyt (tests); defaults to window.flyt like every page here. */
  flyt?: ProjectColorApi | null;
}

/**
 * The record the Color section edits: the active tab, the same record the
 * shell themes. No active tab → the section renders its projectless state.
 */
export function activeProjectRecord(projects: ProjectsPayload | null | undefined): ProjectTabRecord | null {
  const tabs = projects?.tabs;
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  const id = projects?.active;
  if (id == null) return null;
  return tabs.find((tab) => tab?.id === id) ?? null;
}

/** The project's stored color, normalized to '#rrggbb', or null when it has none. */
export function currentProjectColor(project: ProjectTabRecord | null | undefined): string | null {
  if (!project || typeof project !== 'object') return null;
  return normalizeHexColor(project.colorHex) ?? normalizeHexColor(project.color);
}

/** The state pill's label: the preset's name, "Custom", or the auto state. */
export function projectColorLabel(hex: string | null): string {
  if (!hex) return 'auto-assigned';
  const preset = PRESET_PROJECT_COLORS.find((entry) => entry.hex === hex);
  return preset ? preset.name : 'Custom';
}

/**
 * What a commit gesture means to persist: the value normalized, or null when
 * there is nothing to do — no color, junk, or the color already stored. The
 * one gate both commit paths (dialog accept and blur/Enter) go through, so a
 * stray gesture can never write the color that is already on the record.
 */
export function committedHex(value: string | null | undefined, stored: string | null): string | null {
  const hex = normalizeHexColor(value ?? '');
  if (!hex || hex === stored) return null;
  return hex;
}

export default function ProjectColorSettings({
  projects = null,
  onColorChange = null,
  flyt = null,
}: ProjectColorSettingsProps) {
  const api = flyt ?? (typeof window !== 'undefined' ? (window as { flyt?: ProjectColorApi }).flyt : null);
  const project = activeProjectRecord(projects);
  const projectId = typeof project?.id === 'string' ? project.id : null;
  const stored = currentProjectColor(project);

  // The picker mirrors the stored value — the record's own color, or the
  // auto-assigned one once the read-back below lands — never a value this
  // component invented. While a project has no color on its record the picker
  // rests on the applier's fallback preset, which is the color the window is
  // actually wearing at that moment.
  const [pickerValue, setPickerValue] = useState(stored ?? DEFAULT_PROJECT_COLOR_HEX);
  useEffect(() => { setPickerValue(stored ?? DEFAULT_PROJECT_COLOR_HEX); }, [stored]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Persist is the whole interaction: one API call, no save step. The record
  // that comes back is merged over the tab and handed to the host, whose
  // projects state is what the Shell's theme effect watches — that merge is
  // the live re-theme.
  const persist = async (hex: string) => {
    const pid = projectId;
    if (!pid || !api?.projectColor || busy) return;
    setBusy(true);
    setError('');
    try {
      const record = await api.projectColor(pid, hex);
      onColorChange?.({ ...project, ...record });
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  // Commit the picker's current value. Live `input` events only move the local
  // value: dragging across the OS picker must not write settings.json sixty
  // times. The gestures that mean "this color" — the native dialog's accept
  // (the real `change` event, which React does not surface), leaving the
  // control, or Enter — go through committedHex and then the same one write
  // path as a preset click.
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const commitValue = (value: string | null | undefined) => {
    const hex = committedHex(value, stored);
    if (hex) void persist(hex);
  };
  useEffect(() => {
    const el = pickerRef.current;
    if (!el) return undefined;
    // Re-subscribed every render so the closure commits against the current
    // stored value, not the one from the render that first mounted the input.
    const onNativeChange = (event: Event) => commitValue((event.target as HTMLInputElement).value);
    el.addEventListener('change', onNativeChange);
    return () => el.removeEventListener('change', onNativeChange);
  });

  // A record that arrives without a color has one auto-assigned main-side (the
  // registry assigns at open). Read it back once per project — the read is
  // non-writing — so the section, the host's record, and the theme all carry
  // the value the project actually wears, instead of this page quietly
  // assuming a default. Keyed by id, so activating another colorless project
  // while the panel is open reads that one too.
  const readBackFor = useRef<string | null>(null);
  useEffect(() => {
    const pid = projectId;
    if (readBackFor.current === pid || stored != null || !pid || !api?.projectColor) return;
    readBackFor.current = pid;
    api.projectColor(pid).then((record) => {
      if (record?.colorHex) onColorChange?.({ ...project, ...record });
    }).catch(() => { /* a failed read-back is not worth an error banner */ });
  });

  const disabled = busy || !projectId;

  return (
    <section data-project-color-section="true">
      <div className="settings-section-head">
        <span className="section-label">Project color</span>
        {project && <span className="status-pill pill-neutral">{projectColorLabel(stored)}</span>}
      </div>
      <p className="settings-hint">
        The color this project wears — top bar, rail, buttons and a faint tint on the page background.
        One click applies; there is no save step.
      </p>
      {!project && <p className="settings-hint">Open a project to give it a color — this section follows the active tab.</p>}
      <div className="project-color-swatches" role="radiogroup" aria-label="Preset project colors">
        {PRESET_PROJECT_COLORS.map((preset) => {
          const selected = stored != null && preset.hex === stored;
          return (
            <button
              key={preset.hex}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={preset.name}
              className={'project-color-swatch' + (selected ? ' selected' : '')}
              style={{ '--swatch': preset.hex } as React.CSSProperties}
              title={selected ? `${preset.name} — current` : preset.name}
              disabled={disabled}
              onClick={() => void persist(preset.hex)}
            />
          );
        })}
      </div>
      <div className="settings-row project-color-custom">
        <input
          ref={pickerRef}
          type="color"
          className="project-color-picker"
          value={pickerValue}
          list="project-color-preset-values"
          aria-label="Custom project color"
          disabled={disabled}
          onChange={(event) => setPickerValue(event.target.value)}
          onBlur={() => commitValue(pickerValue)}
          onKeyDown={(event) => { if (event.key === 'Enter') commitValue(pickerValue); }}
        />
        <datalist id="project-color-preset-values">
          {PRESET_PROJECT_COLORS.map((preset) => <option key={preset.hex} value={preset.hex} />)}
        </datalist>
        <span className="mono muted project-color-hex">{pickerValue}</span>
      </div>
      {error && <div className="settings-error mono">{error}</div>}
    </section>
  );
}

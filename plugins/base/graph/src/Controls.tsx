import { useEffect, useId, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import type { GraphSettings, SettingsStore } from "./settings.js";

interface ControlsProps {
  readonly store: SettingsStore;
  readonly settings: GraphSettings;
  readonly search: string;
  readonly onSearch: (search: string) => void;
  readonly onRecenter: () => void;
}

type Section = "filters" | "groups" | "display" | "forces";

export function Controls({ store, settings, search, onSearch, onRecenter }: ControlsProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [sections, setSections] = useState<ReadonlySet<Section>>(() => new Set(["filters"]));
  const panelId = useId();
  const toggle = (section: Section): void =>
    setSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  const set = <K extends keyof GraphSettings>(key: K) => (value: GraphSettings[K]) => store.set(key, value);

  return (
    <div className="graph:absolute graph:top-2 graph:right-2 graph:flex graph:max-h-[calc(100%-1rem)] graph:flex-col graph:items-end graph:gap-1">
      <div className="graph:flex graph:gap-1">
        <IconButton label="Fit the graph to the view" onClick={onRecenter}>
          ⤢
        </IconButton>
        <IconButton label="Graph settings" onClick={() => setOpen(!open)} expanded={open} controls={panelId}>
          ⚙
        </IconButton>
      </div>
      {open && (
        <div
          id={panelId}
          className="graph:w-64 graph:overflow-y-auto graph:rounded-lg graph:border graph:border-border graph:bg-bg-raised graph:p-2 graph:text-sm graph:shadow-2 graph:compact:w-[min(16rem,calc(100vw-2rem))]"
        >
          <Group title="Filters" open={sections.has("filters")} onToggle={() => toggle("filters")}>
            <input
              type="search"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Search notes…"
              aria-label="Show notes whose title or folder contains"
              className="graph:w-full graph:rounded graph:border graph:border-border graph:bg-bg graph:px-2 graph:py-1 graph:text-sm graph:text-text"
            />
            <Toggle label="Orphans" checked={settings.showOrphans} onChange={set("showOrphans")} />
            <Toggle label="Missing notes" checked={settings.showMissing} onChange={set("showMissing")} />
            <Toggle label="Embeds" checked={settings.showEmbeds} onChange={set("showEmbeds")} />
            <Toggle label="Frontmatter links" checked={settings.showFrontmatter} onChange={set("showFrontmatter")} />
          </Group>
          <Group title="Groups" open={sections.has("groups")} onToggle={() => toggle("groups")}>
            <Toggle label="Colour by folder" checked={settings.colorByFolder} onChange={set("colorByFolder")} />
          </Group>
          <Group title="Display" open={sections.has("display")} onToggle={() => toggle("display")}>
            <Toggle label="Arrows" checked={settings.arrows} onChange={set("arrows")} />
            <Toggle label="Size by links" checked={settings.sizeByLinks} onChange={set("sizeByLinks")} />
            <Slider label="Text fade threshold" min={-1} max={1} step={0.05} value={settings.textFade} onChange={set("textFade")} />
            <Slider label="Node size" min={0.3} max={3} step={0.05} value={settings.nodeSize} onChange={set("nodeSize")} />
            <Slider label="Link thickness" min={0.3} max={3} step={0.05} value={settings.linkThickness} onChange={set("linkThickness")} />
          </Group>
          <Group title="Forces" open={sections.has("forces")} onToggle={() => toggle("forces")}>
            <Slider label="Center force" min={0} max={1} step={0.01} value={settings.centerForce} onChange={set("centerForce")} />
            <Slider label="Repel force" min={0} max={20} step={0.1} value={settings.repelForce} onChange={set("repelForce")} />
            <Slider label="Link force" min={0} max={1} step={0.01} value={settings.linkForce} onChange={set("linkForce")} />
            <Slider label="Link distance" min={30} max={500} step={1} value={settings.linkDistance} onChange={set("linkDistance")} />
          </Group>
          <button
            type="button"
            onClick={() => store.reset()}
            className="graph:mt-1 graph:w-full graph:cursor-pointer graph:rounded graph:border graph:border-border graph:bg-transparent graph:px-2 graph:py-1 graph:text-xs graph:text-text-muted graph:hover:text-text"
          >
            Restore defaults
          </button>
        </div>
      )}
    </div>
  );
}

interface LocalControlsProps {
  readonly store: SettingsStore;
  readonly settings: GraphSettings;
  readonly openGlobal: (() => void) | undefined;
}

export function LocalControls({ store, settings, openGlobal }: LocalControlsProps): ReactElement {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = root.current?.closest(".graph-view");
    if (!view) return undefined;
    const leave = (event: PointerEvent): void => {
      if (event.pointerType === "mouse" && !view.querySelector(":focus-visible")) setOpen(false);
    };
    const blur = (event: FocusEvent): void => {
      if (!view.contains(event.relatedTarget as Node | null) && !view.matches(":hover")) setOpen(false);
    };
    view.addEventListener("pointerleave", leave as EventListener);
    view.addEventListener("focusout", blur as EventListener);
    return () => {
      view.removeEventListener("pointerleave", leave as EventListener);
      view.removeEventListener("focusout", blur as EventListener);
    };
  }, []);

  return (
    <div
      ref={root}
      data-open={open || undefined}
      className="graph-local-controls graph:absolute graph:top-2 graph:right-2 graph:flex graph:flex-col graph:items-end graph:gap-1"
    >
      <div className="graph:flex graph:gap-1">
        {openGlobal && (
          <IconButton label="Open the full graph" onClick={openGlobal}>
            ⤢
          </IconButton>
        )}
        <IconButton label="Local graph settings" onClick={() => setOpen(!open)} expanded={open} controls={panelId}>
          ⚙
        </IconButton>
      </div>
      {open && (
        <div
          id={panelId}
          className="graph:rounded-lg graph:border graph:border-border graph:bg-bg-raised graph:p-2 graph:text-xs graph:text-text graph:shadow-2"
        >
          <label className="graph:flex graph:items-center graph:gap-2">
            Depth
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={settings.localDepth}
              onChange={(event) => store.set("localDepth", Number(event.target.value))}
              className="graph-range graph:w-28"
            />
            <span className="graph:w-3 graph:tabular-nums graph:text-text-muted">{settings.localDepth}</span>
          </label>
        </div>
      )}
    </div>
  );
}

function IconButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly expanded?: boolean;
  readonly controls?: string;
}): ReactElement {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-expanded={props.expanded}
      aria-controls={props.expanded ? props.controls : undefined}
      onClick={props.onClick}
      className="graph:flex graph:h-8 graph:w-8 graph:cursor-pointer graph:items-center graph:justify-center graph:rounded graph:border graph:border-border graph:bg-bg-raised graph:text-base graph:text-text-muted graph:shadow-1 graph:hover:text-text graph:touch:h-11 graph:touch:w-11"
    >
      {props.children}
    </button>
  );
}

function Group(props: {
  readonly title: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <section className="graph:border-b graph:border-border graph:py-1 graph:last-of-type:border-b-0">
      <button
        type="button"
        aria-expanded={props.open}
        aria-controls={id}
        onClick={props.onToggle}
        className="graph:flex graph:w-full graph:cursor-pointer graph:items-center graph:gap-1 graph:border-0 graph:bg-transparent graph:px-0 graph:py-1 graph:text-left graph:text-sm graph:font-semibold graph:text-text"
      >
        <span aria-hidden="true" className={`graph:inline-block graph:w-3 graph:transition-transform ${props.open ? "graph:rotate-90" : ""}`}>
          ›
        </span>
        {props.title}
      </button>
      {props.open && (
        <div id={id} className="graph:flex graph:flex-col graph:gap-2 graph:pt-1 graph:pb-2">
          {props.children}
        </div>
      )}
    </section>
  );
}

function Toggle(props: { readonly label: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void }): ReactElement {
  return (
    <label className="graph:flex graph:cursor-pointer graph:items-center graph:justify-between graph:gap-2 graph:text-text">
      {props.label}
      <input
        type="checkbox"
        role="switch"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        className="graph-switch"
      />
    </label>
  );
}

function Slider(props: {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly onChange: (value: number) => void;
}): ReactElement {
  return (
    <label className="graph:flex graph:flex-col graph:gap-0.5 graph:text-text">
      <span className="graph:flex graph:justify-between graph:text-xs">
        {props.label}
        <span className="graph:tabular-nums graph:text-text-muted">{Number(props.value.toFixed(2))}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="graph-range graph:w-full"
      />
    </label>
  );
}

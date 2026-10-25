import { type ReactNode, useState } from 'react';
import { useBoard } from '../components/boardContext';
import type { MenuEntry } from '../components/Menu';
import { Panel } from '../components/Panel';
import type { Widget } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import type { BodyDef, MenuContext, WidgetProps } from './types';

// The panel a widget sits in: its title (editable while editing), hide button and ⋯ menu. A
// widget with a `body` gets this from the library without writing any of it; one with its own
// `panel` can use <WidgetFrame> to get the same thing around whatever it draws.

/** A function that changes some of one widget's settings (saved straight away). */
export function settingsSetter<S extends object>(widget: Widget<S>, mutatePreset: MutatePreset) {
  return (patch: Partial<S>) =>
    mutatePreset((d) => {
      const w = d.widgets.find((x) => x.id === widget.id);
      if (w) Object.assign(w.settings, patch);
    });
}

/** The ⋯ menu of a widget that has a settings form: "Settings" / "Close settings". */
export function settingsMenu({ open, toggle }: MenuContext): MenuEntry[] {
  return [{ label: open ? 'Close settings' : 'Settings', icon: 'list', onSelect: toggle }];
}

interface FrameProps {
  widget: Widget<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** What its kind is called: the title when the widget has none of its own. */
  name: string;
  mutatePreset: MutatePreset;
  menu?: MenuEntry[];
  /** Nothing to show yet: hidden in stream mode so viewers never see an empty box. */
  empty?: boolean;
  actions?: ReactNode;
  bleed?: boolean;
  className?: string;
  children: ReactNode;
}

export function WidgetFrame({ widget, name, mutatePreset, menu, empty, actions, bleed, className, children }: FrameProps) {
  const { editing } = useBoard();
  const title = widget.title || name;
  const rename = (value: string) =>
    mutatePreset((d) => {
      const w = d.widgets.find((x) => x.id === widget.id);
      if (w) w.title = value;
    });
  return (
    <Panel
      id={widget.id}
      className={`panel--widget widget--${widget.kind} ${className ?? ''}`}
      label={title}
      empty={empty}
      actions={actions}
      bleed={bleed}
      menu={menu}
      title={editing ? <input className="ghost-input panel__title-input" value={widget.title} placeholder={name} onChange={(e) => rename(e.target.value)} /> : title}
    >
      {children}
    </Panel>
  );
}

/** A widget with a `body`: the frame, then its settings form while editing (if it has one), or the body. */
export function BodyPanel({ def, props }: { def: BodyDef<any>; props: WidgetProps<any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { editing } = useBoard();
  // The ⋯ menu's side view: the settings form, or whatever the body makes of `open`.
  const [open, setOpen] = useState(false);
  const { widget, settings, set, mutatePreset, name } = props;
  const toggle = () => setOpen((o) => !o);
  const empty = def.empty?.(settings) ?? false;
  const menu = def.menu ? def.menu({ open, toggle }) : def.settings ? settingsMenu({ open, toggle }) : undefined;
  const Form = def.settings;
  const Body = def.body;
  return (
    <WidgetFrame widget={widget} name={name} mutatePreset={mutatePreset} menu={menu} empty={empty && !open}>
      {Form && editing && (open || empty) ? (
        <form
          className="widget-settings no-drag"
          onSubmit={(e) => {
            e.preventDefault();
            setOpen(false);
          }}
        >
          <Form settings={settings} set={set} />
          <button className="btn btn--small btn--accent" type="submit">
            Done
          </button>
        </form>
      ) : (
        <Body widget={widget} settings={settings} set={set} editing={editing} open={open} close={() => setOpen(false)} />
      )}
    </WidgetFrame>
  );
}

import type { ReactNode } from 'react';
import { isWidgetId, type BoardId } from '../state/model';
import { BodyPanel, settingsSetter } from './frame';
import { boardDef, panelTitle } from './registry';
import { isSingle, type PanelContext } from './types';

/**
 * Draws what sits on the board under `id`: a single panel from its kind, or a widget from the
 * kind it was added as. Null when there is nothing by that id (a kind this version doesn't know).
 */
export function renderPanel(id: BoardId, c: Omit<PanelContext, 'id' | 'title'>): ReactNode {
  const def = boardDef(id, c.data.widgets);
  if (!def) return null;

  if (isSingle(def)) {
    const Single = def.panel;
    return <Single {...c} id={id} title={panelTitle(c.def, def.kind)} />;
  }

  const widget = isWidgetId(id) ? c.data.widgets.find((w) => w.id === id) : undefined;
  if (!widget) return null;
  const props = {
    ...c,
    id,
    title: widget.title || def.name,
    name: def.name,
    widget,
    settings: widget.settings,
    set: settingsSetter(widget, c.mutatePreset),
  };
  if (def.panel) {
    const Own = def.panel;
    return <Own {...props} />;
  }
  return <BodyPanel def={def} props={props} />;
}

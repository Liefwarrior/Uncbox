// Lets the command palette open the sidebar's "Add an automation" editor.

const EVENT = 'uncbox:add-automation';

export function openAutomationEditor() {
  window.dispatchEvent(new Event(EVENT));
}

/** Calls fn each time something asks for the editor. Returns a function that stops listening. */
export function onAutomationEditor(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

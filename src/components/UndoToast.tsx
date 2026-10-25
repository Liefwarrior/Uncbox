import { scrubText, usePrivate } from '../privacy';
import { dismissUndo, useUndo } from '../undo';
import { Icon } from './Icon';

export function UndoToast() {
  const pending = useUndo();
  // On air, a message that names a folder or an address says only that it is one.
  const hidden = usePrivate();
  if (!pending) return null;
  return (
    <div
      key={pending.key}
      className={`toast ${pending.undo ? '' : 'toast--note'}`}
      role={pending.urgent ? 'alert' : 'status'}
      aria-live={pending.urgent ? 'assertive' : 'polite'}
    >
      <span>{hidden ? scrubText(pending.message) : pending.message}</span>
      {pending.undo && (
        <button
          className="toast__undo"
          onClick={() => {
            pending.undo?.();
            dismissUndo();
          }}
        >
          <Icon name="undo" size={15} /> Undo
        </button>
      )}
    </div>
  );
}

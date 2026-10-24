import { dismissUndo, useUndo } from '../undo';
import { Icon } from './Icon';

export function UndoToast() {
  const pending = useUndo();
  if (!pending) return null;
  return (
    <div
      key={pending.key}
      className={`toast ${pending.undo ? '' : 'toast--note'}`}
      role={pending.urgent ? 'alert' : 'status'}
      aria-live={pending.urgent ? 'assertive' : 'polite'}
    >
      <span>{pending.message}</span>
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

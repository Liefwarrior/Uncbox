import { dismissUndo, useUndo } from '../undo';
import { Icon } from './Icon';

export function UndoToast() {
  const pending = useUndo();
  if (!pending) return null;
  return (
    <div key={pending.key} className="toast" role="status">
      <span>{pending.message}</span>
      <button
        className="toast__undo"
        onClick={() => {
          pending.undo();
          dismissUndo();
        }}
      >
        <Icon name="undo" size={15} /> Undo
      </button>
    </div>
  );
}

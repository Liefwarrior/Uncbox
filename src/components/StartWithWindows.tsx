import { shell, useAutostart } from '../native';

/** "Start with Windows", only inside the Uncbox app: it opens in the tray when you sign in. */
export function StartWithWindows() {
  const [enabled, setEnabled] = useAutostart();
  // In a browser there is no app to ask; before the app answers there is nothing to show.
  if (!shell || enabled === null) return null;
  return (
    <ul className="toggles">
      <li>
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="toggle" />
          <span className="toggles__text">
            Start with Windows
            <small>Opens in the tray when you sign in</small>
          </span>
        </label>
      </li>
    </ul>
  );
}

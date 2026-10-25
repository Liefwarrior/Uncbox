import { useUpdate } from '../update';
import { Icon } from './Icon';

/** A quiet line in the sidebar when a newer Uncbox is out. The link opens the release page in the browser. */
export function UpdateNotice() {
  const update = useUpdate();
  if (!update) return null;
  return (
    <a className="side-link update-notice" href={update.url} target="_blank" rel="noreferrer">
      <Icon name="download" /> Uncbox {update.version} is out. Download
    </a>
  );
}

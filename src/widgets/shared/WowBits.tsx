import type { CSSProperties } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { classColor } from './classColor';
import { qualityColor } from './quality';
import { openItem, type SetupNotice } from './wowGuild';

// Small pieces the WoW guild widgets draw the same way.

/** Why there is nothing to show yet, and what to do about it. On stream (`quiet`) it draws nothing, so viewers never see a setup message. */
export function WowNotice({ notice, quiet, icon = 'users' }: { notice: SetupNotice; quiet?: boolean; icon?: IconName }) {
  if (quiet) return null;
  return (
    <div className="wg-notice" data-notice={notice.id}>
      <Icon name={icon} size={22} />
      <strong>{notice.title}</strong>
      <p className="muted">{notice.hint}</p>
    </div>
  );
}

/** A round mark in the class color. */
export function ClassDot({ cls, hollow, title }: { cls: string; hollow?: boolean; title?: string }) {
  return <span className={`wg-dot ${hollow ? 'is-hollow' : ''}`} style={{ '--wc': classColor(cls) } as CSSProperties} title={title} aria-hidden="true" />;
}

/** A name in its class color. */
export function ClassName({ name, cls, className }: { name: string; cls: string; className?: string }) {
  return (
    <span className={`wg-name ${className ?? ''}`} style={{ color: classColor(cls) }}>
      {name}
    </span>
  );
}

/** An item's name in its quality color, a button that opens its Wowhead page. */
export function ItemLink({ itemId, name, quality }: { itemId: number; name: string; quality: number }) {
  return (
    <button type="button" className="wg-item" style={{ color: qualityColor(quality) }} onClick={() => openItem(itemId)} aria-label={`${name}, open on Wowhead`} title="Open on Wowhead">
      {name || `Item ${itemId}`}
    </button>
  );
}

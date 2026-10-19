import { type CSSProperties, type DragEvent, useRef, useState } from 'react';
import { fileToAvatar, imageFromDrop } from '../image';
import type { PresetDef } from '../presets';
import { emptySlot, MAX_SLOTS, type SlotItem } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { offerUndo } from '../undo';
import { Icon } from './Icon';
import { useBoard } from './Board';
import { Panel } from './Panel';

const SLOT_TYPE = 'application/x-uncbox-slot';

interface Props {
  slots: SlotItem[];
  title: string;
  def: PresetDef['slots'];
  mutatePreset: MutatePreset;
}

/** Pokémon party, SMITE build, WoW group: a short ordered list of named things with pictures. */
export function SlotsPanel({ slots, title, def, mutatePreset }: Props) {
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const firstEmpty = slots.findIndex((m) => !m.name && !m.detail && !m.image);

  const edit = (i: number, patch: Partial<SlotItem>) => mutatePreset((d) => void Object.assign(d.slots[i], patch));
  const onDrop = async (i: number, e: DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const from = e.dataTransfer.getData(SLOT_TYPE);
    if (from !== '') {
      mutatePreset((d) => {
        const [m] = d.slots.splice(Number(from), 1);
        d.slots.splice(i, 0, m);
      });
      return;
    }
    const image = await imageFromDrop(e.dataTransfer).catch(() => null);
    if (image) edit(i, { image });
  };

  return (
    <Panel
      id="slots"
      title={title}
      empty={slots.every((m) => !m.name && !m.detail && !m.image)}
      menu={[
        {
          label: 'Add a slot',
          icon: 'plus',
          disabled: slots.length >= MAX_SLOTS,
          onSelect: () => mutatePreset((d) => void d.slots.push(emptySlot())),
        },
        {
          label: 'Remove the last slot',
          icon: 'minus',
          disabled: slots.length <= 1,
          onSelect: () => {
            const last = slots[slots.length - 1];
            mutatePreset((d) => void d.slots.pop());
            offerUndo('Slot removed', () => mutatePreset((d) => void (d.slots.length < MAX_SLOTS && d.slots.push(last))));
          },
        },
      ]}
    >
      <ol className={`slots slots--${def.variant}`}>
        {slots.map((m, i) => (
          <Slot
            key={m.id}
            index={i}
            item={m}
            hinted={i === firstEmpty}
            def={def}
            highlighted={dropTarget === i}
            onEdit={(patch) => edit(i, patch)}
            onClear={() => {
              mutatePreset((d) => void (d.slots[i] = { ...emptySlot(), id: m.id }));
              offerUndo(`${m.name || 'Slot'} cleared`, () =>
                mutatePreset((d) => {
                  const j = d.slots.findIndex((x) => x.id === m.id);
                  if (j >= 0) d.slots[j] = m;
                }),
              );
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDropTarget(i);
            }}
            onDragLeave={() => setDropTarget((t) => (t === i ? null : t))}
            onDrop={(e) => void onDrop(i, e)}
          />
        ))}
      </ol>
    </Panel>
  );
}

interface SlotProps {
  index: number;
  item: SlotItem;
  /** Only the first empty slot shows example text, so an empty party doesn't read as six of the same thing. */
  hinted: boolean;
  def: PresetDef['slots'];
  highlighted: boolean;
  onEdit: (patch: Partial<SlotItem>) => void;
  onClear: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}

function Slot({ index, item, hinted, def, highlighted, onEdit, onClear, onDragOver, onDragLeave, onDrop }: SlotProps) {
  const { editing } = useBoard();
  const row = useRef<HTMLLIElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const empty = !item.name && !item.detail && !item.image;
  const down = def.showDown && item.down;
  const downLabel = def.down ?? 'Fainted';
  const tint = def.tint?.(item.detail);

  return (
    <li
      ref={row}
      className={`slot ${down ? 'is-down' : ''} ${empty ? 'is-empty' : ''} ${highlighted ? 'is-target' : ''}`}
      style={{ '--n': index, ...(tint ? { '--tint': tint } : {}) } as CSSProperties}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span
        className="slot__grip ctl"
        draggable
        title="Drag to reorder"
        onDragStart={(e) => {
          e.dataTransfer.setData(SLOT_TYPE, String(index));
          e.dataTransfer.effectAllowed = 'move';
          if (row.current) e.dataTransfer.setDragImage(row.current, 16, 16);
        }}
      >
        <Icon name="grip" size={14} />
      </span>

      <button className="slot__art" title="Add a picture (or drop one here)" onClick={() => file.current?.click()}>
        {item.image ? (
          <img src={item.image} alt="" />
        ) : item.name ? (
          <span className="slot__initial">{item.name.slice(0, 1).toUpperCase()}</span>
        ) : (
          <span className="slot__add ctl">
            <Icon name="image" size={18} />
          </span>
        )}
      </button>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onEdit({ image: await fileToAvatar(f) });
        }}
      />

      <div className="slot__text">
        {def.variant === 'tiles' && !editing ? (
          <span className="slot__name slot__name--text">{item.name}</span>
        ) : (
          <input
            className="ghost-input slot__name"
            value={item.name}
            placeholder={hinted ? def.name : ''}
            onChange={(e) => onEdit({ name: e.target.value })}
          />
        )}
        {def.variant === 'list' && (
          <input
            className="ghost-input slot__detail"
            value={item.detail}
            placeholder={hinted ? def.detail : ''}
            onChange={(e) => onEdit({ detail: e.target.value })}
          />
        )}
      </div>

      {down && <span className="slot__ko">{downLabel}</span>}
      <div className="slot__ctl ctl">
        {def.showDown && !empty && (
          <button
            className={`icon-btn ${item.down ? 'on' : ''}`}
            title={item.down ? 'Revive' : `Mark ${downLabel.toLowerCase()}`}
            onClick={() => onEdit({ down: !item.down })}
          >
            <Icon name="skull" size={15} />
          </button>
        )}
        {!empty && (
          <button className="icon-btn" title="Clear slot" onClick={onClear}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

import { type DragEvent, useRef, useState } from 'react';
import { fileToAvatar, imageFromDrop } from '../image';
import { emptyMember, MAX_PARTY, type PartyMember } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { Icon } from './Icon';
import { Panel } from './Panel';

const SLOT_TYPE = 'application/x-party-slot';

export function PartyPanel({ party, mutate }: { party: PartyMember[]; mutate: Mutate }) {
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  const edit = (i: number, patch: Partial<PartyMember>) => mutate((s) => void Object.assign(s.party[i], patch));
  const move = (from: number, to: number) =>
    mutate((s) => {
      const [m] = s.party.splice(from, 1);
      s.party.splice(to, 0, m);
    });

  const onDrop = async (i: number, e: DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const from = e.dataTransfer.getData(SLOT_TYPE);
    if (from !== '') {
      move(Number(from), i);
      return;
    }
    const image = await imageFromDrop(e.dataTransfer).catch(() => null);
    if (image) edit(i, { image });
  };

  return (
    <Panel
      title="Party"
      className="panel--party"
      actions={
        <>
          <button
            className="icon-btn"
            title="Remove last slot"
            disabled={party.length <= 1}
            onClick={() => mutate((s) => void s.party.pop())}
          >
            <Icon name="minus" />
          </button>
          <button
            className="icon-btn"
            title="Add slot"
            disabled={party.length >= MAX_PARTY}
            onClick={() => mutate((s) => void s.party.push(emptyMember()))}
          >
            <Icon name="plus" />
          </button>
        </>
      }
    >
      <ol className="party">
        {party.map((m, i) => (
          <PartySlot
            key={m.id}
            index={i}
            member={m}
            highlighted={dropTarget === i}
            onEdit={(patch) => edit(i, patch)}
            onClear={() => mutate((s) => void (s.party[i] = { ...emptyMember(), id: m.id }))}
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
  member: PartyMember;
  highlighted: boolean;
  onEdit: (patch: Partial<PartyMember>) => void;
  onClear: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}

function PartySlot({ index, member, highlighted, onEdit, onClear, onDragOver, onDragLeave, onDrop }: SlotProps) {
  const row = useRef<HTMLLIElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const empty = !member.name && !member.detail && !member.image;

  return (
    <li
      ref={row}
      className={`slot ${member.down ? 'is-down' : ''} ${empty ? 'is-empty' : ''} ${highlighted ? 'is-target' : ''}`}
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

      <button className="slot__avatar" title="Set image (or drop one here)" onClick={() => file.current?.click()}>
        {member.image ? <img src={member.image} alt="" /> : <span>{index + 1}</span>}
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
        <input
          className="ghost-input slot__name"
          value={member.name}
          placeholder="Empty"
          onChange={(e) => onEdit({ name: e.target.value })}
        />
        <input
          className="ghost-input slot__detail"
          value={member.detail}
          placeholder="Lv / notes"
          onChange={(e) => onEdit({ detail: e.target.value })}
        />
      </div>

      {member.down && <span className="slot__ko">KO</span>}
      <div className="slot__ctl ctl">
        <button
          className={`icon-btn ${member.down ? 'on' : ''}`}
          title={member.down ? 'Revive' : 'Mark as fainted'}
          onClick={() => onEdit({ down: !member.down })}
        >
          KO
        </button>
        {!empty && (
          <button className="icon-btn" title="Clear slot" onClick={onClear}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

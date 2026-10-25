import { Icon, type IconName } from './Icon';
import { Menu } from './Menu';

export interface DropdownOption<T extends string> {
  id: T;
  label: string;
  icon?: IconName;
}

/**
 * A button that shows the current choice and opens a short list of the others: for a row of
 * four or more choices that would otherwise be a strip of buttons. Inside a form, where the
 * choices are plain words, a `<select>` does the same job.
 */
export function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  /** What it picks ("Source"), for screen readers and the tooltip. */
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (id: T) => void;
  className?: string;
}) {
  const current = options.find((o) => o.id === value);
  return (
    <Menu
      label={label}
      align="left"
      className={className}
      trigger={
        <>
          {current?.icon && <Icon name={current.icon} size={14} />}
          <span className="dropdown__value">{current?.label ?? label}</span>
          <Icon name="chevronDown" size={14} />
        </>
      }
      items={options.map((o) => ({ label: o.label, icon: o.icon, selected: o.id === value, onSelect: () => onChange(o.id) }))}
    />
  );
}

/**
 * A dropdown for switching several things on and off at once ("Show: 5 of 7"). The list stays
 * open while you tick, so a few can be changed in one go.
 */
export function MultiDropdown<T extends string>({
  label,
  options,
  values,
  onToggle,
  className = '',
}: {
  label: string;
  options: DropdownOption<T>[];
  values: readonly T[];
  onToggle: (id: T) => void;
  className?: string;
}) {
  return (
    <Menu
      label={label}
      align="left"
      className={className}
      trigger={
        <>
          <span className="dropdown__value">
            {label}: {values.length === options.length ? 'all' : values.length === 0 ? 'none' : `${values.length} of ${options.length}`}
          </span>
          <Icon name="chevronDown" size={14} />
        </>
      }
      items={options.map((o) => ({ label: o.label, icon: o.icon, checked: values.includes(o.id), onSelect: () => onToggle(o.id) }))}
    />
  );
}

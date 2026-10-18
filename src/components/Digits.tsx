/**
 * Numbers in fixed-width cells. The SMITE and WoW display faces have proportional digits, so a
 * ticking timer would change width every second; this keeps the theme font without the jitter.
 */
export function Digits({ value, className }: { value: string | number; className?: string }) {
  return (
    <span className={`digits ${className ?? ''}`} aria-label={String(value)}>
      {Array.from(String(value)).map((ch, i) => (
        <span key={i} className={/\d/.test(ch) ? `digits__d digits__d--${ch}` : 'digits__s'} aria-hidden="true">
          {ch}
        </span>
      ))}
    </span>
  );
}

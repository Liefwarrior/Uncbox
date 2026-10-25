import type { CSSProperties } from 'react';
import { usePoll } from '../shared/usePoll';

// CPU, graphics card and memory, from the Uncbox server (server/widgets.mjs).

export interface SystemStats {
  cpu: number;
  memory: { used: number; total: number };
  gpu: { name: string; load: number; temp: number; used: number; total: number } | null;
}

export const useSystem = () => usePoll<SystemStats>('/api/system', 2000);

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="meter" style={{ '--v': `${Math.min(100, Math.max(0, value))}%` } as CSSProperties}>
      <span className="meter__label">{label}</span>
      <span className="meter__value">{Math.round(value)}%</span>
      <span className="meter__bar" />
      <small>{detail}</small>
    </div>
  );
}

export function SystemBody() {
  const sys = useSystem();
  if (!sys) return null;
  return (
    <div className="widget-system">
      <Meter label="CPU" value={sys.cpu} detail="" />
      {sys.gpu && <Meter label="GPU" value={sys.gpu.load} detail={`${sys.gpu.temp}°C · ${gb(sys.gpu.used)} of ${gb(sys.gpu.total)}`} />}
      <Meter label="Memory" value={(sys.memory.used / sys.memory.total) * 100} detail={`${gb(sys.memory.used)} of ${gb(sys.memory.total)}`} />
    </div>
  );
}

import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Crop, VideoFit } from '../state/model';

interface Props {
  stream: MediaStream;
  fit: VideoFit;
  crop?: Crop;
  pixelated?: boolean;
  mirrored?: boolean;
}

const NO_CROP: Crop = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Plays a MediaStream with edges trimmed off, then fits the remaining region into the container.
 * Cropping is done by oversizing the <video> inside a clipped box, so it costs nothing per frame.
 */
export function CroppedVideo({ stream, fit, crop = NO_CROP, pixelated = false, mirrored = false }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [src, setSrc] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.srcObject = stream;
    const onSize = () => setSrc({ w: v.videoWidth, h: v.videoHeight });
    v.addEventListener('loadedmetadata', onSize);
    v.addEventListener('resize', onSize);
    v.play().catch(() => {});
    return () => {
      v.removeEventListener('loadedmetadata', onSize);
      v.removeEventListener('resize', onSize);
    };
  }, [stream]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clamp = (n: number) => Math.min(Math.max(n, 0), 45) / 100;
  const l = clamp(crop.left);
  const r = clamp(crop.right);
  const t = clamp(crop.top);
  const b = clamp(crop.bottom);

  let frame: CSSProperties = { visibility: 'hidden' };
  let inner: CSSProperties = {};
  if (src.w && src.h && box.w && box.h) {
    const cw = src.w * (1 - l - r);
    const ch = src.h * (1 - t - b);
    let sx: number;
    let sy: number;
    if (fit === 'stretch') {
      sx = box.w / cw;
      sy = box.h / ch;
    } else {
      sx = sy = (fit === 'cover' ? Math.max : Math.min)(box.w / cw, box.h / ch);
    }
    const w = cw * sx;
    const h = ch * sy;
    frame = {
      width: w,
      height: h,
      left: (box.w - w) / 2,
      top: (box.h - h) / 2,
      transform: mirrored ? 'scaleX(-1)' : undefined,
    };
    inner = {
      width: src.w * sx,
      height: src.h * sy,
      left: -src.w * l * sx,
      top: -src.h * t * sy,
    };
  }

  return (
    <div ref={wrap} className="cropped-video">
      <div className="cropped-video__frame" style={frame}>
        <video
          ref={video}
          className={pixelated ? 'pixelated' : undefined}
          style={inner}
          autoPlay
          muted
          playsInline
        />
      </div>
    </div>
  );
}

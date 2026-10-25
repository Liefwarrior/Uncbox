import { type FormEvent, useState } from 'react';
import { watchClip } from '../../clips/replay';
import { Icon } from '../../components/Icon';
import { scrubText, siteHost, usePrivate } from '../../privacy';
import type { BodyProps } from '../types';
import {
  cancelDownload,
  clearDownloads,
  type DownloadItem,
  downloadName,
  etaText,
  type InstallStatus,
  installTools,
  qualityText,
  revealDownload,
  speedText,
  startDownload,
  type Tools,
  useDownloads,
} from './downloads';

// The Video downloader widget: paste a web address and it is saved at the video's own resolution
// and frame rate (yt-dlp, see server/ytdlp.mjs). In stream mode only the progress shows, never the
// address box or the buttons.

const LABEL: Record<DownloadItem['state'], string> = {
  queued: 'Waiting',
  downloading: 'Downloading',
  merging: 'Joining video and sound',
  done: 'Done',
  error: 'Didn’t work',
  cancelled: 'Cancelled',
};

export function DownloadsBody({ editing: controls }: BodyProps<object>) {
  const hidden = usePrivate();
  const { loaded, tools, install, queue, history } = useDownloads();
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState('');
  const [sending, setSending] = useState(false);

  const add = async (audioOnly: boolean) => {
    if (!url.trim()) return;
    setSending(true);
    const why = await startDownload(url, audioOnly);
    setSending(false);
    setProblem(why);
    if (!why) setUrl('');
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void add(false);
  };

  const ready = tools?.ytdlp.found && tools.ffmpeg.found;
  const all = [...queue, ...history];

  if (!controls) {
    // Viewers see what is coming down, nothing to click.
    return queue.length ? (
      <ul className="dl__list">
        {queue.map((i) => (
          <Row key={i.id} item={i} controls={false} />
        ))}
      </ul>
    ) : null;
  }

  return (
    <div className="dl no-drag">
      <form className="dl__add" onSubmit={submit}>
        <input
          value={url}
          placeholder="Paste a video address"
          aria-label="Video address"
          spellCheck={false}
          autoComplete="off"
          type={hidden ? 'password' : 'text'}
          onChange={(e) => {
            setUrl(e.target.value);
            setProblem('');
          }}
        />
        <button className="btn btn--small btn--accent" type="submit" disabled={sending || !url.trim() || !ready}>
          <Icon name="download" size={14} /> Download
        </button>
        <button className="btn btn--small" type="button" disabled={sending || !url.trim() || !ready} onClick={() => void add(true)}>
          Audio only
        </button>
      </form>
      {problem && <p className="error">{problem}</p>}
      {loaded && <ToolsBar tools={tools} install={install} />}
      {all.length > 0 ? (
        <>
          <ul className="dl__list">
            {all.map((i) => (
              <Row key={i.id} item={i} controls />
            ))}
          </ul>
          {history.length > 0 && (
            <button className="btn btn--small dl__clear" onClick={clearDownloads} title="Clears this list; the files stay in your Downloads folder">
              Clear list
            </button>
          )}
        </>
      ) : (
        loaded && ready && <p className="muted dl__empty">Downloads keep the video’s own resolution and frame rate.</p>
      )}
    </div>
  );
}

function Row({ item, controls }: { item: DownloadItem; controls: boolean }) {
  // What is being downloaded can be private (a video you are watching, a path); on air it is only the site.
  const hidden = usePrivate();
  const name = hidden ? `A video from ${siteHost(item.url) || 'the web'}` : downloadName(item);
  const active = item.state === 'downloading' || item.state === 'merging';
  const quality = qualityText(item);
  const meta =
    item.state === 'downloading'
      ? [quality, speedText(item.speed), item.eta !== null ? `${etaText(item.eta)} left` : ''].filter(Boolean)
      : item.state === 'error'
        ? []
        : [quality, LABEL[item.state] === 'Done' ? '' : LABEL[item.state]].filter(Boolean);
  return (
    <li className={`dl__item dl__item--${item.state}`}>
      <p className="dl__title" title={hidden ? name : item.url}>
        {name}
      </p>
      {item.state === 'error' ? (
        <p className="error dl__meta">{hidden ? scrubText(item.error) : item.error}</p>
      ) : (
        <p className="muted dl__meta">{meta.join(' · ')}</p>
      )}
      {active && (
        <div
          className="dl__bar"
          role="progressbar"
          aria-label={name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(item.percent)}
        >
          <i style={{ width: `${item.percent}%` }} />
        </div>
      )}
      {controls && (
        <div className="dl__buttons">
          {(item.state === 'queued' || active) && (
            <button className="btn btn--small" onClick={() => cancelDownload(item.id)}>
              Cancel
            </button>
          )}
          {item.state === 'done' && (
            <>
              {item.name && (
                <button className="btn btn--small btn--accent" onClick={() => watchClip(item.name)}>
                  <Icon name="play" size={13} /> Play
                </button>
              )}
              {item.name && (
                <button className="btn btn--small" title="Open the video with Make vertical ready" onClick={() => watchClip(item.name, true)}>
                  <Icon name="crop" size={13} /> Make vertical
                </button>
              )}
              <button className="btn btn--small" onClick={() => revealDownload(item.id)}>
                <Icon name="folder" size={13} /> Show in folder
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Whether yt-dlp and ffmpeg are there: install buttons with live output when they aren't, versions and Update when they are. */
function ToolsBar({ tools, install }: { tools: Tools | null; install: InstallStatus }) {
  const [problem, setProblem] = useState('');
  if (!tools) return null;
  const missing = [!tools.ytdlp.found && 'yt-dlp', !tools.ffmpeg.found && 'ffmpeg'].filter(Boolean) as ('yt-dlp' | 'ffmpeg')[];
  const run = async (tool: 'yt-dlp' | 'ffmpeg' | 'both', upgrade = false) => setProblem(await installTools(tool, upgrade));

  return (
    <div className="dl__tools">
      {missing.length > 0 && (
        <div className="dl__missing">
          <p>{missing.join(' and ')} {missing.length > 1 ? 'aren’t' : 'isn’t'} installed on this PC yet.</p>
          {tools.winget ? (
            <div className="dl__buttons">
              {missing.map((t) => (
                <button key={t} className="btn btn--small btn--accent" disabled={install.running} onClick={() => void run(t)}>
                  {install.running && install.tool === t ? 'Installing…' : `Install ${t}`}
                </button>
              ))}
              {missing.length > 1 && (
                <button className="btn btn--small" disabled={install.running} onClick={() => void run('both')}>
                  Install both
                </button>
              )}
            </div>
          ) : (
            <p className="muted">
              Windows Package Manager isn’t on this PC, so Uncbox can’t install them for you.{' '}
              <a href={tools.helpUrl} target="_blank" rel="noreferrer noopener">
                How to install yt-dlp
              </a>
              .
            </p>
          )}
        </div>
      )}
      {missing.length === 0 && (
        <p className="muted dl__versions">
          yt-dlp {tools.ytdlp.version || 'found'} · ffmpeg {tools.ffmpeg.version.split('-')[0] || 'found'}
          {tools.winget && (
            <>
              {' '}
              <button className="btn btn--small" disabled={install.running} onClick={() => void run('both', true)}>
                {install.running && install.action === 'upgrade' ? 'Updating…' : 'Update'}
              </button>
            </>
          )}
        </p>
      )}
      {(problem || install.error) && <p className="error">{problem || install.error}</p>}
      {(install.running || install.error) && install.lines.length > 0 && (
        <pre className="dl__log" aria-live="polite">
          {install.lines.slice(-8).join('\n')}
        </pre>
      )}
    </div>
  );
}

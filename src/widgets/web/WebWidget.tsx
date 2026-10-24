import { type FormEvent, useEffect, useState } from 'react';
import { useBoard } from '../../components/boardContext';
import { Icon } from '../../components/Icon';
import { shell, useWebView, web } from '../../native';
import type { Widget } from '../../state/model';
import {
  canGoBack,
  canGoForward,
  clampZoom,
  cleanUrl,
  currentOf,
  FRAME_ALLOW,
  goBack,
  goForward,
  MAX_ZOOM,
  MIN_ZOOM,
  resolveAddress,
  sandboxFor,
  SEARCH_ENGINES,
  startHistory,
  useFrameable,
  useWebOpenRequests,
  visit,
} from '../../web';
import { downloadFromHere, downloadUrl } from '../downloads/downloads';
import { settingsSetter, WidgetFrame } from '../frame';
import type { WidgetProps } from '../types';
import type { WebSettings } from './settings';

type SetSettings = (patch: Partial<WebSettings>) => void;

const openInBrowser = (url: string) => {
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
};

/**
 * A web page in a panel. In the Uncbox app a real WebView2 sits over the panel and can show any
 * site; in a browser it's an iframe, which sites can refuse (and which can't tell us where the page
 * went, so back and forward only cover pages opened from this panel).
 */
export function WebPanel({ widget, name, mutatePreset }: WidgetProps<WebSettings>) {
  const { editing } = useBoard();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<HTMLDivElement | null>(null);
  const s = widget.settings;
  const set: SetSettings = settingsSetter(widget, mutatePreset);
  // Here, above the panel's settings form, so the page and its history stay while that is open.
  const browser = useBrowser(widget, view, set);
  useWebOpenRequests(widget.id, browser.go);
  const settingsShown = editing && settingsOpen;

  return (
    <WidgetFrame
      widget={widget}
      name={name}
      mutatePreset={mutatePreset}
      menu={[
        { label: settingsOpen ? 'Close settings' : 'Settings', icon: 'list', onSelect: () => setSettingsOpen((o) => !o) },
        { label: 'Reload', icon: 'refresh', onSelect: browser.reload, disabled: !browser.url },
        { label: 'Open in browser', icon: 'external', onSelect: () => openInBrowser(browser.url), disabled: !browser.url },
        { label: 'Download video from this page', icon: 'download', onSelect: () => void downloadFromHere(browser.url), disabled: !downloadUrl(browser.url) },
      ]}
    >
      {settingsShown ? (
        <WebSettingsForm settings={s} set={set} onDone={() => setSettingsOpen(false)} />
      ) : (
        <div className="web">
          {!s.hideToolbar && <Toolbar browser={browser} engine={s.searchEngine} home={cleanUrl(s.homeUrl)} />}
          <div className="web__page">
            {shell ? <div ref={setView} className="web__native" /> : <Frame browser={browser} zoom={clampZoom(s.zoom)} />}
            {!browser.url && (
              <p className="web__start muted">{s.hideToolbar ? 'Set a home page in this widget’s settings.' : 'Type a web address, or something to search for.'}</p>
            )}
          </div>
        </div>
      )}
    </WidgetFrame>
  );
}

// ---- the page and its history ----

interface Browser {
  /** Where the page is now ('' if nowhere yet). */
  url: string;
  title: string;
  canBack: boolean;
  canForward: boolean;
  loading: boolean;
  /** Bumped by a reload, so a frame starts over. */
  reloads: number;
  go: (url: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
}

function useBrowser(widget: Widget<WebSettings>, view: HTMLElement | null, set: SetSettings): Browser {
  const s = widget.settings;
  // Where it starts: where it was (saved), else the home page.
  const [start] = useState(() => cleanUrl(s.url) || cleanUrl(s.homeUrl));
  const [history, setHistory] = useState(() => startHistory(start));
  const [wanted, setWanted] = useState(start);
  const [reloads, setReloads] = useState(0);
  const native = useWebView(widget.id, shell ? view : null, wanted, clampZoom(s.zoom));

  const url = shell ? (native?.url ?? wanted) : currentOf(history);
  // The page it's on is saved with the widget, so a reload of Uncbox comes back to it.
  useEffect(() => {
    if (url && url !== s.url) set({ url });
    // set is a new function every render; the page changing is what matters.
  }, [url]);

  if (shell) {
    return {
      url,
      title: native?.title ?? '',
      canBack: native?.canGoBack ?? false,
      canForward: native?.canGoForward ?? false,
      loading: native?.loading ?? false,
      reloads,
      // A new request is sent by useWebView; asking again for the page last asked for (the view has
      // moved on by links since) has to be sent here.
      go: (to) => (to === wanted ? web.open(widget.id, to) : setWanted(to)),
      back: () => web.nav(widget.id, 'back'),
      forward: () => web.nav(widget.id, 'forward'),
      reload: () => web.nav(widget.id, 'reload'),
    };
  }
  return {
    url,
    title: '',
    canBack: canGoBack(history),
    canForward: canGoForward(history),
    loading: false,
    reloads,
    go: (to) => setHistory((h) => visit(h, to)),
    back: () => setHistory(goBack),
    forward: () => setHistory(goForward),
    reload: () => setReloads((n) => n + 1),
  };
}

// ---- the bar ----

function Toolbar({ browser, engine, home }: { browser: Browser; engine: string; home: string }) {
  // What's typed while the address box is in use; otherwise it shows where the page is.
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const address = resolveAddress(draft ?? browser.url, engine);
    if (address.kind === 'blocked') return setProblem('Only web addresses (http and https) can be opened here.');
    if (address.kind === 'empty') return;
    setProblem('');
    setDraft(null);
    browser.go(address.url);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <form className={`web-bar no-drag ${browser.loading ? 'is-loading' : ''}`} onSubmit={submit}>
      <button className="icon-btn" type="button" title="Back" aria-label="Back" disabled={!browser.canBack} onClick={browser.back}>
        <Icon name="arrowLeft" size={15} />
      </button>
      <button className="icon-btn" type="button" title="Forward" aria-label="Forward" disabled={!browser.canForward} onClick={browser.forward}>
        <Icon name="arrowRight" size={15} />
      </button>
      <button className="icon-btn" type="button" title="Reload" aria-label="Reload" disabled={!browser.url} onClick={browser.reload}>
        <Icon name="refresh" size={15} />
      </button>
      <input
        className="web-bar__address"
        value={draft ?? browser.url}
        placeholder="Search or type a web address"
        aria-label="Address"
        spellCheck={false}
        autoComplete="off"
        title={browser.title || browser.url}
        onFocus={(e) => {
          setDraft(browser.url);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setProblem('');
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      {home && (
        <button className="icon-btn" type="button" title="Home page" aria-label="Home page" onClick={() => browser.go(home)}>
          <Icon name="home" size={15} />
        </button>
      )}
      <button className="icon-btn" type="button" title="Open in browser" aria-label="Open in browser" disabled={!browser.url} onClick={() => openInBrowser(browser.url)}>
        <Icon name="external" size={15} />
      </button>
      {problem && <p className="web-bar__problem">{problem}</p>}
    </form>
  );
}

// ---- the page, in a browser ----

function Frame({ browser, zoom }: { browser: Browser; zoom: number }) {
  const { url, reloads } = browser;
  const frameable = useFrameable(url, true);
  if (!url) return null;
  if (frameable === 'checking') return <p className="web__note muted">Opening…</p>;
  if (frameable === 'blocked') {
    return (
      <div className="web__note web__blocked">
        <h3>This site won’t open here</h3>
        <p className="muted">
          This site doesn’t allow being shown inside other pages. Open it in your browser, or use the Uncbox app, which can show any site.
        </p>
        <button className="btn btn--small btn--accent no-drag" onClick={() => openInBrowser(url)}>
          Open in browser
        </button>
      </div>
    );
  }
  // Zoomed by drawing the page bigger or smaller and scaling it to fit.
  const z = zoom / 100;
  return (
    <iframe
      key={`${url} ${reloads}`}
      className="web__frame no-drag"
      title={url}
      src={url}
      sandbox={sandboxFor(url, window.location.origin)}
      allow={FRAME_ALLOW}
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
      style={{ width: `${100 / z}%`, height: `${100 / z}%`, transform: `scale(${z})` }}
    />
  );
}

// ---- settings, shown in the panel while editing ----

function WebSettingsForm({ settings: s, set, onDone }: { settings: WebSettings; set: SetSettings; onDone: () => void }) {
  const [home, setHome] = useState(s.homeUrl);
  const [problem, setProblem] = useState('');

  /** The typed home page as a web address, kept as typed (and the problem said) if it isn't one. */
  const saveHome = (): boolean => {
    const address = resolveAddress(home, s.searchEngine);
    if (address.kind === 'empty') {
      set({ homeUrl: '' });
      setProblem('');
      return true;
    }
    if (address.kind !== 'url') {
      setProblem('That isn’t a web address. Try something like youtube.com.');
      return false;
    }
    setHome(address.url);
    set({ homeUrl: address.url });
    setProblem('');
    return true;
  };

  return (
    <form
      className="widget-settings no-drag"
      onSubmit={(e) => {
        e.preventDefault();
        if (saveHome()) onDone();
      }}
    >
      <label>
        Home page
        <input data-setup="" value={home} placeholder="youtube.com" spellCheck={false} onChange={(e) => setHome(e.target.value)} onBlur={saveHome} />
      </label>
      {problem && <p className="error">{problem}</p>}
      <label>
        Search with
        <select value={s.searchEngine} onChange={(e) => set({ searchEngine: e.target.value })}>
          {SEARCH_ENGINES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Zoom: {clampZoom(s.zoom)}%
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={10}
          value={clampZoom(s.zoom)}
          onChange={(e) => set({ zoom: clampZoom(Number(e.target.value)) })}
        />
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.hideToolbar} onChange={(e) => set({ hideToolbar: e.target.checked })} /> Hide the toolbar, for a clean
        view on stream
      </label>
      <button className="btn btn--small btn--accent" type="submit">
        Done
      </button>
    </form>
  );
}

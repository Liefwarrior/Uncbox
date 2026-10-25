// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OnAirToggle } from './components/OnAirToggle';
import type { ObsSnapshot } from './obs';
import { isBrowserSource } from './widgets/media/media';
import { isPrivate, obsIsLive, PrivacyProvider, privateReason, resetOnAirForTests, scrubText, setOnAir, siteHost, usePrivate } from './privacy';

const live = (over: { stream?: boolean; record?: boolean; connected?: boolean; reconnecting?: boolean } = {}) =>
  ({
    connected: over.connected ?? true,
    stream: { active: over.stream ?? false, reconnecting: over.reconnecting ?? false },
    record: { active: over.record ?? false, paused: false, timecode: '' },
  }) as Pick<ObsSnapshot, 'connected' | 'stream' | 'record'>;

describe('the private signal', () => {
  const off = { streamMode: false, obsLive: false, onAir: false };

  it('is off when nothing is on', () => {
    expect(isPrivate(off)).toBe(false);
    expect(privateReason(off)).toBeNull();
  });

  it('each of the three turns it on alone', () => {
    expect(isPrivate({ ...off, streamMode: true })).toBe(true);
    expect(isPrivate({ ...off, obsLive: true })).toBe(true);
    expect(isPrivate({ ...off, onAir: true })).toBe(true);
  });

  it('says which one, with OBS first', () => {
    expect(privateReason({ streamMode: true, obsLive: true, onAir: true })).toBe('obs');
    expect(privateReason({ streamMode: true, obsLive: false, onAir: true })).toBe('stream');
    expect(privateReason({ ...off, onAir: true })).toBe('manual');
  });

  it('counts OBS as live while streaming, reconnecting or recording, not when idle or unreachable', () => {
    expect(obsIsLive(null)).toBe(false);
    expect(obsIsLive(live())).toBe(false);
    expect(obsIsLive(live({ stream: true }))).toBe(true);
    expect(obsIsLive(live({ record: true }))).toBe(true);
    expect(obsIsLive(live({ reconnecting: true }))).toBe(true);
    expect(obsIsLive(live({ stream: true, connected: false }))).toBe(false);
  });
});

function Probe() {
  return <p data-testid="probe">{usePrivate() ? 'private' : 'public'}</p>;
}

describe('the provider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetOnAirForTests();
  });
  afterEach(cleanup);

  const status = () => screen.getByTestId('probe').textContent;
  const obs = (over: Parameters<typeof live>[0]) => live(over) as ObsSnapshot;

  it('is public with nothing on', () => {
    render(
      <PrivacyProvider streamMode={false} obs={null}>
        <Probe />
      </PrivacyProvider>,
    );
    expect(status()).toBe('public');
  });

  it('is private in the stream mode view alone', () => {
    render(
      <PrivacyProvider streamMode obs={null}>
        <Probe />
      </PrivacyProvider>,
    );
    expect(status()).toBe('private');
  });

  it('is private while OBS is live alone', () => {
    render(
      <PrivacyProvider streamMode={false} obs={obs({ stream: true })}>
        <Probe />
      </PrivacyProvider>,
    );
    expect(status()).toBe('private');
  });

  it('is private with the manual switch alone, and follows it', () => {
    render(
      <PrivacyProvider streamMode={false} obs={null}>
        <Probe />
      </PrivacyProvider>,
    );
    act(() => setOnAir(true));
    expect(status()).toBe('private');
    act(() => setOnAir(false));
    expect(status()).toBe('public');
  });

  it('remembers the switch', () => {
    setOnAir(true);
    expect(window.localStorage.getItem('uncbox.onAir')).toBe('1');
    resetOnAirForTests();
    render(
      <PrivacyProvider streamMode={false} obs={null}>
        <Probe />
      </PrivacyProvider>,
    );
    expect(status()).toBe('private');
  });

  it('is public outside a provider', () => {
    render(<Probe />);
    expect(status()).toBe('public');
  });
});

describe('the On air pill', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetOnAirForTests();
  });
  afterEach(cleanup);

  const pill = () => screen.getByRole('button');

  it('toggles by hand', () => {
    render(
      <PrivacyProvider streamMode={false} obs={null}>
        <OnAirToggle />
      </PrivacyProvider>,
    );
    expect(pill().textContent).toBe('Off air');
    expect(pill().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pill());
    expect(pill().textContent).toBe('On air: personal info hidden');
    expect(pill().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(pill());
    expect(pill().textContent).toBe('Off air');
  });

  it('shows it is forced on while OBS is live, and the click does nothing', () => {
    render(
      <PrivacyProvider streamMode={false} obs={live({ stream: true }) as ObsSnapshot}>
        <OnAirToggle />
      </PrivacyProvider>,
    );
    expect(pill().textContent).toContain('On air: personal info hidden');
    expect(pill().textContent).toContain('OBS is live');
    fireEvent.click(pill());
    expect(window.localStorage.getItem('uncbox.onAir')).toBeNull();
  });
});

describe('shortening', () => {
  it('turns a web address into its site', () => {
    expect(siteHost('https://mail.google.com/mail/u/0/#inbox/abc?x=1')).toBe('mail.google.com');
    expect(siteHost('not a url')).toBe('');
  });

  it('takes paths and email addresses out of a message', () => {
    expect(scrubText('Saved C:\\Users\\eli\\Videos\\clip.mp4')).toBe('Saved a folder on this PC');
    expect(scrubText('Signed in as eli.t@gmail.com.')).toBe('Signed in as an email address.');
    expect(scrubText('Copied to \\\\NAS\\share\\x')).toBe('Copied to a network folder');
    expect(scrubText('Clip saved')).toBe('Clip saved');
  });

  it('knows a browser from a music app', () => {
    expect(isBrowserSource('Chrome')).toBe(true);
    expect(isBrowserSource('Microsoft Edge')).toBe(true);
    expect(isBrowserSource('Firefox')).toBe(true);
    expect(isBrowserSource('Spotify')).toBe(false);
    expect(isBrowserSource(undefined)).toBe(false);
  });
});

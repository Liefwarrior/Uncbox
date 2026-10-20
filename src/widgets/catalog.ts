import type { IconName } from '../components/Icon';
import { uid, type Widget, type WidgetId, type WidgetSettings, type WidgetType } from '../state/model';

// The widget library: small panels you can add any number of, from "Add a widget" in the
// sidebar. Each type has a component in ./index.tsx; this is what they're called and how big.

export interface WidgetInfo {
  name: string;
  /** One plain line for the sidebar. */
  hint: string;
  icon: IconName;
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export const WIDGET_INFO: Record<WidgetType, WidgetInfo> = {
  clock: { name: 'Clock', hint: 'The time, here or anywhere', icon: 'clock', w: 4, h: 3, minW: 2, minH: 2 },
  weather: { name: 'Weather', hint: 'Now and today, for any place', icon: 'sun', w: 4, h: 4, minW: 3, minH: 3 },
  media: { name: 'Now playing', hint: 'The song or video playing on this PC', icon: 'music', w: 6, h: 3, minW: 4, minH: 2 },
  notifications: { name: 'Notifications', hint: 'Windows notifications as they arrive', icon: 'bell', w: 6, h: 5, minW: 4, minH: 3 },
  system: { name: 'System', hint: 'CPU, graphics card and memory', icon: 'gauge', w: 4, h: 4, minW: 3, minH: 3 },
  network: { name: 'Ping & FPS', hint: 'Your connection, and frame rate in a game', icon: 'wifi', w: 4, h: 4, minW: 2, minH: 2 },
  countdown: { name: 'Countdown', hint: 'Time left until something', icon: 'timer', w: 4, h: 3, minW: 3, minH: 2 },
  focus: { name: 'Focus timer', hint: 'Work and break rounds, with a chime', icon: 'timer', w: 4, h: 5, minW: 3, minH: 3 },
  launcher: { name: 'Launcher', hint: 'Quick buttons for apps, folders and sites', icon: 'rocket', w: 6, h: 4, minW: 2, minH: 2 },
  drive: { name: 'Google Drive', hint: 'Your recent, starred and shared files', icon: 'cloud', w: 6, h: 6, minW: 4, minH: 4 },
  text: { name: 'Text', hint: 'Any words you like', icon: 'type', w: 5, h: 3, minW: 2, minH: 2 },
  obs: { name: 'OBS', hint: 'Stream health, scenes and recording', icon: 'cast', w: 6, h: 6, minW: 3, minH: 2 },
  web: { name: 'Web', hint: 'Any web page: YouTube, a wiki, a dashboard', icon: 'globe', w: 8, h: 7, minW: 3, minH: 3 },
  twitch: { name: 'Twitch stream', hint: 'Viewers, followers and your title', icon: 'twitch', w: 6, h: 7, minW: 4, minH: 3 },
};

export function defaultWidgetSettings(): WidgetSettings {
  return {
    timeZone: '',
    hour12: !new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h2'),
    seconds: false,
    place: '',
    lat: 0,
    lon: 0,
    celsius: false,
    apps: '',
    showBody: false,
    target: 0,
    text: '',
    pingTarget: '',
    showRouter: true,
    focusWork: 25,
    focusShort: 5,
    focusLong: 15,
    focusRounds: 4,
    focusAuto: false,
    focusSound: true,
    focusPhase: 'work',
    focusRound: 1,
    focusEndsAt: 0,
    focusLeft: 0,
    launcherTiles: [],
    url: '',
    homeUrl: '',
    searchEngine: 'google',
    hideToolbar: false,
    zoom: 100,
    driveView: 'recent',
  };
}

export function newWidget(type: WidgetType): Widget {
  return { id: `wdg-${uid()}` as WidgetId, type, title: '', settings: defaultWidgetSettings() };
}

export function widgetTitle(w: Widget): string {
  return w.title || WIDGET_INFO[w.type].name;
}

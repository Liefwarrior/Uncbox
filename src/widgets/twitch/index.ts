import { defineWidget } from '../types';
import { TwitchBody } from './TwitchBody';

export const twitch = defineWidget({
  kind: 'twitch',
  name: 'Twitch stream',
  hint: 'Viewers, followers and your title',
  icon: 'twitch',
  category: 'Streaming',
  keywords: 'viewers followers title category channel live',
  w: 6,
  h: 7,
  minW: 4,
  minH: 3,
  defaults: () => ({}),
  body: TwitchBody,
});

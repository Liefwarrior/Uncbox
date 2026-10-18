import { useEffect, useState } from 'react';
import type { AppState } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { type ChatStatus, emoteUrl, isBot, normalizeChannel, useTwitchChat } from '../twitch';
import { useBoard } from './Board';
import { Icon } from './Icon';
import { Panel } from './Panel';

const STATUS_TEXT: Record<ChatStatus, string> = {
  idle: 'No channel',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Could not join',
};

interface Props {
  twitch: AppState['twitch'];
  title: string;
  mutate: Mutate;
}

/** Slim, read-only Twitch chat styled by the preset theme instead of Twitch's own embed. */
export function ChatPanel({ twitch, title, mutate }: Props) {
  const { editing } = useBoard();
  const channel = normalizeChannel(twitch.channel);
  const { messages, status, notice } = useTwitchChat(channel);
  const [draft, setDraft] = useState(twitch.channel);
  useEffect(() => setDraft(twitch.channel), [twitch.channel]);

  const shown = twitch.hideBots ? messages.filter((m) => m.system || !isBot(m.login)) : messages;
  const commit = () => mutate((s) => void (s.twitch.channel = draft.trim()));

  return (
    <Panel
      id="chat"
      label={title}
      empty={!channel}
      title={
        channel ? (
          <>
            {title} <span className="panel__sub">{channel}</span>
          </>
        ) : (
          title
        )
      }
      actions={channel && <span className={`live-dot live-dot--${status}`} title={STATUS_TEXT[status]} />}
      menu={[
        {
          label: 'Hide bot messages',
          checked: twitch.hideBots,
          onSelect: () => mutate((s) => void (s.twitch.hideBots = !s.twitch.hideBots)),
        },
      ]}
    >
      {editing && (
        <form
          className="chat-channel"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <Icon name="message" size={14} />
          <input value={draft} placeholder="Your Twitch channel name" data-setup onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
        </form>
      )}
      {!channel ? (
        <p className="chat-empty muted ctl">Type your channel name above and chat shows up here.</p>
      ) : (
        <ol className="chat" aria-live="polite">
          {shown.length === 0 && (
            <li className="chat-empty muted ctl">
              {status === 'error' ? notice || 'Could not join that channel.' : status === 'connected' ? 'Waiting for chat…' : 'Connecting…'}
            </li>
          )}
          {shown.map((m) =>
            m.system ? (
              <li key={m.id} className="chat__msg chat__msg--system">
                {m.parts.map((p) => (p.kind === 'text' ? p.text : p.name)).join('')}
              </li>
            ) : (
              <li key={m.id} className={`chat__msg ${m.action ? 'is-action' : ''}`}>
                <span className="chat__name" style={{ color: m.color }}>
                  {m.name}
                </span>
                <span className="chat__text" style={m.action ? { color: m.color } : undefined}>
                  {m.parts.map((p, i) =>
                    p.kind === 'text' ? (
                      <span key={i}>{p.text}</span>
                    ) : (
                      <img key={i} className="chat__emote" src={emoteUrl(p.id)} alt={p.name} title={p.name} />
                    ),
                  )}
                </span>
              </li>
            ),
          )}
        </ol>
      )}
    </Panel>
  );
}

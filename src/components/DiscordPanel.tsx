import { useEffect, useState } from 'react';
import { discordApi, type Guild, useDiscord, type VoiceChannel } from '../discord';
import type { AppState, PinnedChannel } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { useBoard } from './Board';
import { Icon } from './Icon';
import { Panel } from './Panel';

interface Props {
  pinned: AppState['discord']['pinned'];
  title: string;
  mutate: Mutate;
}

/**
 * Discord voice, drawn by Uncbox in the preset's theme: who is in your channel and who is
 * talking, your mute/deafen, and pinned channels you can hop into without leaving the board.
 */
export function DiscordPanel({ pinned, title, mutate }: Props) {
  const { editing } = useBoard();
  const d = useDiscord();
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const ready = d.status === 'ready';

  const run = (action: () => Promise<unknown>) => {
    setError('');
    action().catch((err: Error) => setError(err.message));
  };

  return (
    <Panel
      id="discord"
      label={title}
      title={
        d.channel ? (
          <>
            {title} <span className="panel__sub">{d.channel.name}</span>
          </>
        ) : (
          title
        )
      }
      actions={
        ready &&
        d.channel && (
          <>
            <button
              className={`icon-btn ${d.self.mute ? 'is-off' : ''}`}
              title={d.self.mute ? 'Unmute' : 'Mute'}
              onClick={() => run(() => discordApi.voice({ mute: !d.self.mute }))}
            >
              <Icon name={d.self.mute ? 'micOff' : 'mic'} size={15} />
            </button>
            <button
              className={`icon-btn ${d.self.deaf ? 'is-off' : ''}`}
              title={d.self.deaf ? 'Undeafen' : 'Deafen'}
              onClick={() => run(() => discordApi.voice({ deaf: !d.self.deaf }))}
            >
              <Icon name={d.self.deaf ? 'headphonesOff' : 'headphones'} size={15} />
            </button>
            <button className="icon-btn" title="Leave voice" onClick={() => run(discordApi.leave)}>
              <Icon name="leave" size={15} />
            </button>
          </>
        )
      }
    >
      <div className="voice">
        {d.status === 'unconfigured' || d.status === 'error' ? (
          editing ? (
            <Setup error={d.error} clientId={d.clientId} />
          ) : null
        ) : d.status === 'offline' ? (
          <p className="voice__note ctl">Discord isn’t running.</p>
        ) : d.status === 'connecting' ? (
          <p className="voice__note ctl">Connecting to Discord…</p>
        ) : d.status === 'needs-auth' || d.status === 'authorizing' ? (
          <div className="voice__auth ctl">
            <button
              className="btn btn--accent"
              disabled={d.status === 'authorizing'}
              onClick={() => run(discordApi.authorize)}
            >
              {d.status === 'authorizing' ? 'Approve in Discord…' : 'Authorize in Discord'}
            </button>
            {d.error && <p className="error">{d.error}</p>}
          </div>
        ) : (
          <>
            {d.channel ? (
              <ul className="voice__members">
                {d.members.map((m) => (
                  <li key={m.id} className={`member ${m.speaking ? 'is-speaking' : ''}`}>
                    <span className="member__avatar">
                      <img src={m.avatar} alt="" />
                    </span>
                    <span className="member__name">{m.name}</span>
                    {m.deaf ? (
                      <Icon name="headphonesOff" size={14} />
                    ) : m.mute ? (
                      <Icon name="micOff" size={14} />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="voice__note ctl">Not in a voice channel.</p>
            )}

            {(pinned.length > 0 || editing) && (
              <div className="voice__pins ctl">
                {pinned.map((c) => (
                  <span key={c.id} className={`pin ${d.channel?.id === c.id ? 'on' : ''}`}>
                    <button
                      className="pin__join"
                      title={d.channel?.id === c.id ? 'You are here' : `Join ${c.name}`}
                      disabled={d.channel?.id === c.id}
                      onClick={() => run(() => discordApi.join(c.id))}
                    >
                      <Icon name="speaker" size={14} />
                      <span className="pin__name">{c.name}</span>
                      <span className="pin__guild">{c.guildName}</span>
                    </button>
                    {editing && (
                      <button
                        className="icon-btn"
                        title="Unpin"
                        onClick={() =>
                          mutate((s) => void (s.discord.pinned = s.discord.pinned.filter((p) => p.id !== c.id)))
                        }
                      >
                        <Icon name="x" size={12} />
                      </button>
                    )}
                  </span>
                ))}
                {editing && !picking && (
                  <button className="btn btn--small" onClick={() => setPicking(true)}>
                    <Icon name="plus" size={13} /> Pin a channel
                  </button>
                )}
              </div>
            )}
            {editing && picking && (
              <ChannelPicker
                pinned={pinned}
                onPin={(c) => mutate((s) => void s.discord.pinned.push(c))}
                onClose={() => setPicking(false)}
              />
            )}
          </>
        )}
        {error && <p className="error ctl">{error}</p>}
      </div>
    </Panel>
  );
}

function Setup({ error, clientId }: { error: string; clientId: string }) {
  const [id, setId] = useState(clientId);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  return (
    <form
      className="voice__setup no-drag"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        setMessage('');
        discordApi
          .configure(id, secret)
          .catch((err: Error) => setMessage(err.message))
          .finally(() => setSaving(false));
      }}
    >
      <ol>
        <li>
          Create an app at{' '}
          <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
            discord.com/developers
          </a>
          .
        </li>
        <li>
          Under OAuth2, add the redirect <code>http://localhost</code>, then copy the Client ID and Client Secret.
        </li>
      </ol>
      <input value={id} placeholder="Client ID" inputMode="numeric" onChange={(e) => setId(e.target.value)} />
      <input
        value={secret}
        type="password"
        placeholder="Client Secret"
        autoComplete="off"
        onChange={(e) => setSecret(e.target.value)}
      />
      <button className="btn btn--accent" disabled={saving || !id.trim() || !secret.trim()}>
        Connect
      </button>
      {(message || error) && <p className="error">{message || error}</p>}
    </form>
  );
}

function ChannelPicker({
  pinned,
  onPin,
  onClose,
}: {
  pinned: PinnedChannel[];
  onPin: (c: PinnedChannel) => void;
  onClose: () => void;
}) {
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  const [guild, setGuild] = useState<Guild | null>(null);
  const [channels, setChannels] = useState<VoiceChannel[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    discordApi
      .guilds()
      .then(setGuilds)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!guild) return;
    setChannels(null);
    discordApi
      .channels(guild.id)
      .then(setChannels)
      .catch((err: Error) => setError(err.message));
  }, [guild]);

  return (
    <div className="picker no-drag">
      <div className="picker__head">
        <select
          value={guild?.id ?? ''}
          onChange={(e) => setGuild(guilds?.find((g) => g.id === e.target.value) ?? null)}
        >
          <option value="">{guilds ? 'Choose a server' : 'Loading servers…'}</option>
          {guilds?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="Done" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {guild && (
        <ul className="picker__list">
          {!channels && <li className="muted">Loading channels…</li>}
          {channels?.length === 0 && <li className="muted">No voice channels.</li>}
          {channels?.map((c) => {
            const isPinned = pinned.some((p) => p.id === c.id);
            return (
              <li key={c.id}>
                <button
                  disabled={isPinned}
                  onClick={() => onPin({ id: c.id, name: c.name, guildId: guild.id, guildName: guild.name })}
                >
                  <Icon name="speaker" size={14} /> {c.name}
                  {isPinned && <span className="muted"> · pinned</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

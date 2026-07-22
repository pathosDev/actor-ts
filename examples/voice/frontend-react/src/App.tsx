import { useState, type FormEvent, type PointerEvent as RPointerEvent } from 'react';
import { useVoice } from './useVoice';
import type { ClientMessage } from './protocol';

type VoiceHandle = ReturnType<typeof useVoice>;

/**
 * Root component — splits between three phases (gate-mic, gate-login,
 * app).  All real plumbing lives in `useVoice`; this file is a thin
 * UI binding.  Mirrors the chat sample's `App.tsx` shape.
 */
export function App(): React.JSX.Element {
  const voice = useVoice();
  switch (voice.state.phase) {
    case 'gate-mic':   return <GateMicView voice={voice} />;
    case 'gate-login': return <GateLoginView voice={voice} />;
    case 'app':        return <AppView voice={voice} />;
  }
}

function GateMicView({ voice }: { voice: VoiceHandle }): React.JSX.Element {
  return (
    <div className="gate">
      <h1>actor-ts voice</h1>
      <p className="hint">
        Click "Enable mic" once.  Grants the mic permission AND unlocks
        the AudioContext for inbound playback (browsers gate both
        behind a user gesture).
      </p>
      <button className="primary" type="button" onClick={() => voice.enableMic()}>Enable mic</button>
      <div className="err">{voice.state.loginError}</div>
    </div>
  );
}

function GateLoginView({ voice }: { voice: VoiceHandle }): React.JSX.Element {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!u.trim() || !p) return;
    voice.login(u.trim(), p);
  };
  return (
    <div className="gate">
      <h1>actor-ts voice</h1>
      <p className="hint">Pick a user.  Passwords visible below.</p>
      <form onSubmit={onSubmit} autoComplete="off">
        <input value={u} onChange={(e) => setU(e.target.value)} placeholder="username" required />
        <input value={p} onChange={(e) => setP(e.target.value)} type="password" placeholder="password" required />
        <button className="primary" type="submit">Log in</button>
        <div className="err">{voice.state.loginError}</div>
      </form>
      <div className="creds">
        <strong>Test users</strong> (visible by design):{' '}
        <code>alice</code>/<code>wonderland</code>,{' '}
        <code>bob</code>/<code>builder</code>,{' '}
        <code>charlie</code>/<code>chaplin</code>,{' '}
        <code>diana</code>/<code>prince</code>.
      </div>
    </div>
  );
}

function AppView({ voice }: { voice: VoiceHandle }): React.JSX.Element {
  const { state } = voice;

  function ptt(target: ClientMessage & { kind: 'voice-target' }, key: string, label: string, big = false, disabled = false): React.JSX.Element {
    const onDown = (e: RPointerEvent<HTMLButtonElement>): void => {
      e.preventDefault();
      if (disabled) return;
      voice.beginPress(target, key);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    const onUp = (e: RPointerEvent<HTMLButtonElement>): void => {
      e.preventDefault();
      voice.endPress(key);
    };
    return (
      <button
        className={(big ? 'ptt-big' : 'ptt') + (state.activeKey === key ? ' active' : '')}
        disabled={disabled}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={(e) => { if (state.activeKey === key) onUp(e); }}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="me">{state.username}</div>
        <div className="meter"><span style={{ width: state.micPct + '%' }} /></div>
        <div className="talking">
          {state.incomingNames.length === 0 ? 'no incoming audio' : '🔊 ' + state.incomingNames.join(' · ')}
        </div>
        <button onClick={() => voice.logout()}>Logout</button>
      </header>
      <div className="panes">
        <section>
          <h2 className="section">Users</h2>
          <ul className="users">
            {state.directory.users.map((u) => {
              const online = state.onlineUsers.has(u);
              const isSelf = u === state.username;
              return (
                <li key={u}>
                  <span className={'dot' + (online ? ' online' : '')} />
                  <span className={'username' + (isSelf ? ' self' : '')}>{u}</span>
                  {!isSelf && ptt({ kind: 'voice-target', mode: 'peer', target: u }, `peer:${u}`, 'PTT', false, !online)}
                </li>
              );
            })}
          </ul>
        </section>
        <section>
          <h2 className="section">Groups</h2>
          <div className="groups">
            {state.directory.groups.map((g) => {
              const isMember = g.members.includes(state.username ?? '');
              return (
                <div key={g.name} className="group-card">
                  <div className="head"><span className="name">{g.name}</span></div>
                  <div className="members">{g.members.join(', ')}</div>
                  {ptt({ kind: 'voice-target', mode: 'group', group: g.name }, `group:${g.name}`, 'Hold to talk', true, !isMember)}
                </div>
              );
            })}
          </div>
        </section>
        <section>
          <h2 className="section">Rooms</h2>
          <div className="rooms">
            {state.directory.rooms.map((r) => {
              const entered = state.joinedRooms.has(r);
              const talking = state.roomTalking.has(r);
              const parts = state.roomParticipants.get(r) ?? [];
              return (
                <div key={r} className={'room' + (entered ? ' entered' : '')}>
                  <div className="head">
                    <span className="name">{r}</span>
                    {entered ? (
                      <>
                        <button className={'talk' + (talking ? ' active' : '')}
                                onClick={() => voice.toggleRoomTalk(r)}>{talking ? 'Stop' : 'Talk'}</button>
                        <button className="leave" onClick={() => voice.leaveRoom(r)}>Leave</button>
                      </>
                    ) : (
                      <button className="enter" onClick={() => voice.enterRoom(r)}>Enter</button>
                    )}
                  </div>
                  <div className="participants">{parts.length === 0 ? '— empty —' : parts.join(', ')}</div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

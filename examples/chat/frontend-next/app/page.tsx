'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useChat } from '../lib/useChat';
import { isDmRoom, type RoomName } from '../lib/protocol';

/**
 * Single client-rendered page that swaps between LoginView and
 * ChatView.  We keep the whole thing on one route to mirror the
 * Vite + Angular variants — the `app/` folder structure is the
 * point of comparison, not the routing graph.
 *
 * Under static export the page is pre-rendered at build time with
 * `phase: 'login'` (sessionStorage doesn't exist on the build
 * machine).  To avoid both a hydration mismatch and the brief
 * login-form flash on a reload, we render `null` until the
 * `useEffect` in `useChat` has had a chance to flip phase to
 * 'resuming'.  The `hydrated` flag also defers the first paint
 * past hydration, so the login form never appears for tokens that
 * are about to resume successfully.
 */
export default function Page(): React.JSX.Element | null {
  const chat = useChat();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  if (!hydrated) return null;
  switch (chat.state.phase) {
    case 'login':    return <LoginView chat={chat} />;
    case 'chat':     return <ChatView chat={chat} />;
    case 'resuming': return null;
  }
}

type ChatHandle = ReturnType<typeof useChat>;

function LoginView({ chat }: { chat: ChatHandle }): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    chat.connect(username.trim(), password);
  };

  return (
    <div className="login">
      <h1>actor-ts chat</h1>
      <p className="lead">Next.js frontend</p>
      <form onSubmit={onSubmit} autoComplete="off">
        <input
          name="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          required
        />
        <input
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          required
        />
        <button type="submit">Log in</button>
        <div className="err">{chat.state.loginError}</div>
      </form>
      <div className="creds">
        <strong>Test users</strong>: <code>alice</code>/<code>wonderland</code>,{' '}
        <code>bob</code>/<code>builder</code>, <code>charlie</code>/<code>chaplin</code>,{' '}
        <code>diana</code>/<code>prince</code>
      </div>
    </div>
  );
}

/**
 * "+ new room" form below the Rooms list.  Local invalid-state lives
 * here (not in `useChat`) — it's per-input UI state, not part of the
 * chat session.
 */
function RoomCreateForm({ chat }: { chat: ChatHandle }): React.JSX.Element {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!chat.createRoom(value.trim())) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setValue('');
  };
  return (
    <form
      className="room-create"
      onSubmit={onSubmit}
      autoComplete="off"
      title="Create a new room (a–z, 0–9, _-, 1–32 chars)"
    >
      <input
        value={value}
        onChange={(e) => { setValue(e.target.value); setInvalid(false); }}
        placeholder="+ new room"
        maxLength={32}
        className={invalid ? 'invalid' : ''}
      />
      <button type="submit">Add</button>
    </form>
  );
}

function ChatView({ chat }: { chat: ChatHandle }): React.JSX.Element {
  const { state } = chat;
  const messages = state.currentRoom ? (state.messagesByRoom[state.currentRoom] ?? []) : [];
  let users = state.currentRoom ? (state.usersByRoom[state.currentRoom] ?? []) : [];
  // DM rooms never get `users` frames; synthesize a two-person list
  // from the room name.
  if (state.currentRoom && isDmRoom(state.currentRoom) && users.length === 0) {
    users = [state.currentRoom.slice(1), ...(state.username ? [state.username] : [])];
  }

  const onSend = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const input = e.currentTarget.querySelector('input') as HTMLInputElement | null;
    const text = input?.value.trim() ?? '';
    if (!text || !state.currentRoom) return;
    chat.send(state.currentRoom as RoomName, text);
    if (input) input.value = '';
  };

  return (
    <div className="chat">
      <header className="bar">
        <div>
          <strong>actor-ts chat</strong> — {state.username}
        </div>
        <button onClick={() => chat.logout()}>Logout</button>
      </header>
      <div className="layout">
        <aside>
          <h2>Rooms</h2>
          <ul className="rooms">
            {state.rooms.map((room) => {
              const unread = state.unreadByRoom[room] ?? 0;
              const active = room === state.currentRoom;
              const dm = isDmRoom(room);
              const cls = [active ? 'active' : '', dm ? 'dm' : ''].join(' ').trim();
              return (
                <li
                  key={room}
                  className={cls}
                  onClick={() => chat.selectRoom(room)}
                >
                  <span>{dm ? room : `# ${room}`}</span>
                  {unread > 0 && <span className="badge">{unread}</span>}
                </li>
              );
            })}
          </ul>
          <RoomCreateForm chat={chat} />
        </aside>
        <main className="center">
          <div className="messages">
            {messages.map((m, i) => (
              <div className="msg" key={i}>
                <span className="from">{m.from}:</span>
                {m.text}
                <span className="ts">{new Date(m.ts).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
          <form className="compose" onSubmit={onSend}>
            <input placeholder="Type a message..." autoComplete="off" />
            <button type="submit">Send</button>
          </form>
        </main>
        <aside>
          <h2>Online ({users.length})</h2>
          <ul className="users">
            {users.map((u) => {
              const isSelf = u === state.username;
              return (
                <li
                  key={u}
                  className={isSelf ? 'self' : ''}
                  title={isSelf ? '' : `Click to message @${u}`}
                  onClick={isSelf ? undefined : () => chat.openDm(u)}
                >
                  {u}
                  {isSelf ? ' (you)' : ''}
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
    </div>
  );
}

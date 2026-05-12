import { useState, type FormEvent } from 'react';
import type { RoomName } from './protocol';
import { useChat } from './useChat';

/**
 * Root component — splits between login and chat phases.  In the
 * 'resuming' phase we render nothing: that's the brief window
 * after a page reload when the stored token is being re-validated
 * by the server.  Rendering the login form there would cause a
 * visible flash before the server replies with `logged-in`.
 * Uses `useChat` for all state + WS handling.
 */
export function App(): React.JSX.Element | null {
  const chat = useChat();
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
      <p className="lead">React + Vite frontend</p>
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
 * "+ new room" form in the Rooms aside.  Local invalid-state lives
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
  const users = state.currentRoom ? (state.usersByRoom[state.currentRoom] ?? []) : [];

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
              return (
                <li
                  key={room}
                  className={active ? 'active' : ''}
                  onClick={() => chat.selectRoom(room)}
                >
                  <span># {room}</span>
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
            {users.map((u) => (
              <li key={u}>
                {u}
                {u === state.username ? ' (you)' : ''}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

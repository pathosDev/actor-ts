import { useEffect, useState, type FormEvent } from 'react';
import { isDmRoom, type RoomName } from './protocol';
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
  let users = state.currentRoom ? (state.usersByRoom[state.currentRoom] ?? []) : [];
  // DM rooms don't get `users` frames — synthesize a two-person list
  // from the room name (`@<other>`) so the panel stays useful.
  if (state.currentRoom && isDmRoom(state.currentRoom) && users.length === 0) {
    users = [state.currentRoom.slice(1), ...(state.username ? [state.username] : [])];
  }
  const typingPeers = state.currentRoom ? (state.typingByRoom[state.currentRoom] ?? []) : [];
  const typingText =
    typingPeers.length === 0 ? ''
    : typingPeers.length === 1 ? `${typingPeers[0]} is typing…`
    : typingPeers.length === 2 ? `${typingPeers[0]} and ${typingPeers[1]} are typing…`
    : `${typingPeers.length} people are typing…`;
  const receipts = state.currentRoom ? (state.receiptsByRoom[state.currentRoom] ?? {}) : {};

  // When the active room changes OR a new message arrives in the
  // current room, mark the highest visible ts as read.  Effect runs
  // every render that changes `messages` or `currentRoom`; the
  // hook's internal debounce drops no-op writes.
  useEffect(() => {
    if (!state.currentRoom || messages.length === 0) return;
    const maxTs = messages.reduce((a, m) => Math.max(a, m.ts), 0);
    if (maxTs > 0) chat.markReadUpTo(state.currentRoom as RoomName, maxTs);
  }, [state.currentRoom, messages, chat]);

  const onSend = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const input = e.currentTarget.querySelector('input') as HTMLInputElement | null;
    const text = input?.value.trim() ?? '';
    if (!text || !state.currentRoom) return;
    chat.send(state.currentRoom as RoomName, text);
    if (input) input.value = '';
  };
  const onComposeInput = (): void => {
    if (state.currentRoom) chat.notifyTyping(state.currentRoom as RoomName);
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
            {messages.map((m, i) => {
              const isOwn = m.from === state.username;
              const readers = isOwn
                ? Object.entries(receipts)
                    .filter(([u, t]) => u !== state.username && typeof t === 'number' && t >= m.ts)
                    .map(([u]) => u)
                : [];
              return (
                <div className="msg" key={i}>
                  <span className="from">{m.from}:</span>
                  {m.text}
                  <span className="ts">{new Date(m.ts).toLocaleTimeString()}</span>
                  {isOwn && (
                    <span
                      className={readers.length > 0 ? 'receipt read' : 'receipt'}
                      title={readers.length > 0 ? `read by ${readers.join(', ')}` : 'sent'}
                    >
                      {readers.length > 0 ? '✓✓' : '✓'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="typing">{typingText}</div>
          <form className="compose" onSubmit={onSend}>
            <input
              placeholder="Type a message..."
              autoComplete="off"
              onInput={onComposeInput}
            />
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

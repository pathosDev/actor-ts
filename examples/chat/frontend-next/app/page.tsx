'use client';

import { useState, type FormEvent } from 'react';
import { useChat } from '../lib/useChat';
import type { RoomName } from '../lib/protocol';

/**
 * Single client-rendered page that swaps between LoginView and
 * ChatView.  We keep the whole thing on one route to mirror the
 * Vite + Angular variants — the `app/` folder structure is the
 * point of comparison, not the routing graph.
 */
export default function Page(): React.JSX.Element {
  const chat = useChat();
  return chat.state.phase === 'login' ? <LoginView chat={chat} /> : <ChatView chat={chat} />;
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
              return (
                <li
                  key={room}
                  className={room === state.currentRoom ? 'active' : ''}
                  onClick={() => chat.selectRoom(room)}
                >
                  <span># {room}</span>
                  {unread > 0 && <span className="badge">{unread}</span>}
                </li>
              );
            })}
          </ul>
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

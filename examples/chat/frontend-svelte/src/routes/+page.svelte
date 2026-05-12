<!--
  Single-route SvelteKit app: switches between the login form and
  the chat view based on `chat.phase`.  All state lives in the
  shared runes-backed store under `$lib/chat.svelte.ts`.
-->
<script lang="ts">
  import { chat } from '$lib/chat.svelte';
  import { isDmRoom, type RoomName } from '$lib/protocol';

  let username = $state('');
  let password = $state('');
  let composeText = $state('');
  let newRoomName = $state('');
  let newRoomInvalid = $state(false);

  function onLogin(e: SubmitEvent): void {
    e.preventDefault();
    if (!username.trim() || !password) return;
    chat.connect(username.trim(), password);
  }

  function onSend(e: SubmitEvent): void {
    e.preventDefault();
    const room = chat.currentRoom as RoomName | null;
    if (!room || !composeText.trim()) return;
    chat.send(room, composeText);
    composeText = '';
  }

  function onComposeInput(): void {
    if (chat.currentRoom) chat.notifyTyping(chat.currentRoom as RoomName);
  }

  function onCreateRoom(e: SubmitEvent): void {
    e.preventDefault();
    if (!chat.createRoom(newRoomName.trim())) {
      newRoomInvalid = true;
      return;
    }
    newRoomInvalid = false;
    newRoomName = '';
  }

  function fmtTs(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }
</script>

{#if chat.phase === 'login'}
  <div class="login">
    <h1>actor-ts chat</h1>
    <p class="lead">SvelteKit frontend</p>
    <form onsubmit={onLogin} autocomplete="off">
      <input bind:value={username} name="username" placeholder="username" required />
      <input bind:value={password} name="password" type="password" placeholder="password" required />
      <button type="submit">Log in</button>
      <div class="err">{chat.loginError}</div>
    </form>
    <div class="creds">
      <strong>Test users</strong>:
      <code>alice</code>/<code>wonderland</code>,
      <code>bob</code>/<code>builder</code>,
      <code>charlie</code>/<code>chaplin</code>,
      <code>diana</code>/<code>prince</code>
    </div>
  </div>
{:else if chat.phase === 'resuming'}
  <!--
    Render nothing while the stored token is being resumed against
    the server.  Either the next frame is 'chat' (logged-in) or
    'login' (login-failed / retry-exhausted).  Avoids the brief
    login-form-flash on page reload.
  -->
{:else}
  <div class="chat">
    <header class="bar">
      <div><strong>actor-ts chat</strong> — {chat.username}</div>
      <button onclick={() => chat.logout()}>Logout</button>
    </header>
    <div class="layout">
      <aside>
        <h2>Rooms</h2>
        <ul class="rooms">
          {#each chat.rooms as room (room)}
            {@const unread = chat.unreadByRoom[room] ?? 0}
            {@const dm = isDmRoom(room)}
            <li
              class:active={room === chat.currentRoom}
              class:dm
              onclick={() => chat.selectRoom(room)}
              role="button"
              tabindex="0"
              onkeydown={(e) => e.key === 'Enter' && chat.selectRoom(room)}
            >
              <span>{dm ? room : `# ${room}`}</span>
              {#if unread > 0}
                <span class="badge">{unread}</span>
              {/if}
            </li>
          {/each}
        </ul>
        <form
          class="room-create"
          onsubmit={onCreateRoom}
          autocomplete="off"
          title="Create a new room (a–z, 0–9, _-, 1–32 chars)"
        >
          <input
            bind:value={newRoomName}
            placeholder="+ new room"
            maxlength="32"
            class:invalid={newRoomInvalid}
            oninput={() => (newRoomInvalid = false)}
          />
          <button type="submit">Add</button>
        </form>
      </aside>
      <main class="center">
        {@const currentReceipts = chat.currentRoom ? chat.receiptsByRoom[chat.currentRoom] ?? {} : {}}
        <div class="messages">
          {#each (chat.currentRoom ? chat.messagesByRoom[chat.currentRoom] ?? [] : []) as m}
            {@const isOwn = m.from === chat.username}
            {@const readers = isOwn
              ? Object.entries(currentReceipts)
                  .filter(([u, t]) => u !== chat.username && typeof t === 'number' && t >= m.ts)
                  .map(([u]) => u)
              : []}
            <div class="msg">
              <span class="from">{m.from}:</span>{m.text}
              <span class="ts">{fmtTs(m.ts)}</span>
              {#if isOwn}
                <span
                  class="receipt"
                  class:read={readers.length > 0}
                  title={readers.length > 0 ? `read by ${readers.join(', ')}` : 'sent'}
                >{readers.length > 0 ? '✓✓' : '✓'}</span>
              {/if}
            </div>
          {/each}
        </div>
        {@const typingPeers = chat.currentRoom ? chat.typingByRoom[chat.currentRoom] ?? [] : []}
        {@const typingText =
          typingPeers.length === 0 ? ''
          : typingPeers.length === 1 ? `${typingPeers[0]} is typing…`
          : typingPeers.length === 2 ? `${typingPeers[0]} and ${typingPeers[1]} are typing…`
          : `${typingPeers.length} people are typing…`}
        <div class="typing">{typingText}</div>
        <form class="compose" onsubmit={onSend}>
          <input
            bind:value={composeText}
            placeholder="Type a message..."
            autocomplete="off"
            oninput={onComposeInput}
          />
          <button type="submit">Send</button>
        </form>
      </main>
      {@const baseUsers = chat.currentRoom ? chat.usersByRoom[chat.currentRoom] ?? [] : []}
      {@const displayedUsers = (chat.currentRoom && isDmRoom(chat.currentRoom) && baseUsers.length === 0
        ? [chat.currentRoom.slice(1), chat.username ?? '']
        : baseUsers).filter((u) => !!u)}
      <aside>
        <h2>Online ({displayedUsers.length})</h2>
        <ul class="users">
          {#each displayedUsers as u (u)}
            {@const isSelf = u === chat.username}
            <li
              class:self={isSelf}
              title={isSelf ? '' : `Click to message @${u}`}
              onclick={() => !isSelf && chat.openDm(u)}
              role="button"
              tabindex="0"
              onkeydown={(e) => !isSelf && e.key === 'Enter' && chat.openDm(u)}
            >
              {u}{isSelf ? ' (you)' : ''}
            </li>
          {/each}
        </ul>
      </aside>
    </div>
  </div>
{/if}

<style>
  .login {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 1rem;
  }
  .login form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 280px;
    margin-top: 1rem;
  }
  .login input,
  .login form button {
    padding: 0.5rem 0.75rem;
    font: inherit;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .login form button {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
    cursor: pointer;
  }
  .err { color: crimson; min-height: 1.2em; font-size: 0.9rem; }
  .creds {
    margin-top: 1.5rem;
    font-size: 0.85rem;
    background: var(--soft);
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    max-width: 320px;
  }
  .lead { color: #888; margin: 0; }

  .chat { height: 100vh; display: flex; flex-direction: column; }
  .bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .bar button {
    font: inherit;
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: transparent;
    cursor: pointer;
  }
  .layout {
    flex: 1;
    display: grid;
    grid-template-columns: 220px 1fr 220px;
    min-height: 0;
  }
  aside {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
  }
  aside:last-child { border-right: none; border-left: 1px solid var(--border); }
  aside h2 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #888;
    margin: 0;
    padding: 0.75rem 1rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 0 0.5rem 0;
    overflow-y: auto;
    flex: 1;
  }
  .rooms li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 1rem;
    cursor: pointer;
    border-left: 3px solid transparent;
  }
  .rooms li.active {
    background: var(--soft);
    border-left-color: var(--accent);
    font-weight: 600;
  }
  .rooms li.dm span:first-child { font-style: italic; }
  .badge {
    background: var(--accent);
    color: white;
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
  }
  .users li { padding: 0.4rem 1rem; cursor: pointer; }
  .users li.self { cursor: default; color: #888; }
  main.center { display: flex; flex-direction: column; min-height: 0; }
  .messages { flex: 1; overflow-y: auto; padding: 0.75rem 1rem; }
  .msg { margin-bottom: 0.4rem; }
  .from { font-weight: 600; margin-right: 0.4rem; }
  .ts { color: #888; font-size: 0.75rem; margin-left: 0.5rem; }
  .receipt { color: #888; font-size: 0.85rem; margin-left: 0.35rem; }
  .receipt.read { color: var(--accent); }
  .typing {
    font-size: 0.8rem;
    font-style: italic;
    color: #888;
    padding: 0.25rem 1rem;
    min-height: 1.2em;
    border-top: 1px solid var(--border);
  }
  form.compose {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--border);
  }
  form.compose input {
    flex: 1;
    font: inherit;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  form.compose button {
    font: inherit;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: white;
    cursor: pointer;
  }
  form.room-create {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--border);
  }
  form.room-create input {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 0.25rem 0.4rem;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  form.room-create input.invalid { border-color: crimson; }
  form.room-create button {
    font: inherit;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: white;
    cursor: pointer;
  }
</style>

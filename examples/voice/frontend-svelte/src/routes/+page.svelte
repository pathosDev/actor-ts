<script lang="ts">
  import { voice } from '$lib/voice.svelte';

  let usernameInput = $state('');
  let passwordInput = $state('');

  function onLogin(e: SubmitEvent): void {
    e.preventDefault();
    if (!usernameInput.trim() || !passwordInput) return;
    voice.login(usernameInput.trim(), passwordInput);
  }
</script>

{#if voice.phase === 'gate-mic'}
  <div class="gate">
    <h1>actor-ts voice</h1>
    <p class="hint">
      Click "Enable mic" once.  Grants the mic permission AND unlocks
      the AudioContext for inbound playback (browsers gate both
      behind a user gesture).
    </p>
    <button class="primary" type="button" onclick={() => voice.enableMic()}>Enable mic</button>
    <div class="err">{voice.loginError}</div>
  </div>
{:else if voice.phase === 'gate-login'}
  <div class="gate">
    <h1>actor-ts voice</h1>
    <p class="hint">Pick a user.  Passwords visible below.</p>
    <form onsubmit={onLogin} autocomplete="off">
      <input bind:value={usernameInput} name="username" placeholder="username" required />
      <input bind:value={passwordInput} name="password" type="password" placeholder="password" required />
      <button class="primary" type="submit">Log in</button>
      <div class="err">{voice.loginError}</div>
    </form>
    <div class="creds">
      <strong>Test users</strong> (visible by design):
      <code>alice</code>/<code>wonderland</code>,
      <code>bob</code>/<code>builder</code>,
      <code>charlie</code>/<code>chaplin</code>,
      <code>diana</code>/<code>prince</code>.
    </div>
  </div>
{:else}
  <div class="app">
    <header class="topbar">
      <div class="me">{voice.username}</div>
      <div class="meter"><span style:width={voice.micPct + '%'}></span></div>
      <div class="talking">
        {voice.incomingNames.length === 0 ? 'no incoming audio' : '🔊 ' + voice.incomingNames.join(' · ')}
      </div>
      <button onclick={() => voice.logout()}>Logout</button>
    </header>
    <div class="panes">
      <section>
        <h2 class="section">Users</h2>
        <ul class="users">
          {#each voice.directory.users as u (u)}
            {@const online = voice.onlineUsers.has(u)}
            {@const isSelf = u === voice.username}
            {@const key = `peer:${u}`}
            <li>
              <span class="dot" class:online></span>
              <span class="username" class:self={isSelf}>{u}</span>
              {#if !isSelf}
                <button class="ptt" class:active={voice.activeKey === key}
                        disabled={!online}
                        onpointerdown={(e) => { e.preventDefault(); voice.beginPress({ type: 'voice-target', mode: 'peer', target: u }, key); (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId); }}
                        onpointerup={(e) => { e.preventDefault(); voice.endPress(key); }}
                        onpointercancel={() => voice.endPress(key)}>PTT</button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>

      <section>
        <h2 class="section">Groups</h2>
        <div class="groups">
          {#each voice.directory.groups as g (g.name)}
            {@const isMember = g.members.includes(voice.username ?? '')}
            {@const key = `group:${g.name}`}
            <div class="group-card">
              <div class="head"><span class="name">{g.name}</span></div>
              <div class="members">{g.members.join(', ')}</div>
              <button class="ptt-big" class:active={voice.activeKey === key}
                      disabled={!isMember}
                      title={isMember ? '' : 'You are not a member of this group.'}
                      onpointerdown={(e) => { e.preventDefault(); voice.beginPress({ type: 'voice-target', mode: 'group', group: g.name }, key); (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId); }}
                      onpointerup={(e) => { e.preventDefault(); voice.endPress(key); }}
                      onpointercancel={() => voice.endPress(key)}>Hold to talk</button>
            </div>
          {/each}
        </div>
      </section>

      <section>
        <h2 class="section">Rooms</h2>
        <div class="rooms">
          {#each voice.directory.rooms as r (r)}
            {@const entered = voice.joinedRooms.has(r)}
            {@const talking = voice.roomTalking.has(r)}
            {@const parts = voice.roomParticipants.get(r) ?? []}
            <div class="room" class:entered>
              <div class="head">
                <span class="name">{r}</span>
                {#if entered}
                  <button class="talk" class:active={talking}
                          onclick={() => voice.toggleRoomTalk(r)}>{talking ? 'Stop' : 'Talk'}</button>
                  <button class="leave" onclick={() => voice.leaveRoom(r)}>Leave</button>
                {:else}
                  <button class="enter" onclick={() => voice.enterRoom(r)}>Enter</button>
                {/if}
              </div>
              <div class="participants">{parts.length === 0 ? '— empty —' : parts.join(', ')}</div>
            </div>
          {/each}
        </div>
      </section>
    </div>
  </div>
{/if}

<style>
  .gate {
    height: 100vh;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    text-align: center; gap: 1rem; padding: 1rem;
  }
  .gate .hint { color: #888; max-width: 480px; }
  .gate form { display: flex; flex-direction: column; gap: .5rem; min-width: 280px; }
  .gate input, .gate button {
    padding: .5rem .75rem; border-radius: 6px;
    border: 1px solid var(--border); font: inherit;
  }
  button.primary { background: #4f46e5; color: white; border-color: #4f46e5; cursor: pointer; }
  .err { color: #dc2626; min-height: 1.4em; font-size: .9rem; }
  .creds {
    margin-top: 1.5rem; max-width: 380px; font-size: .85rem;
    padding: .5rem .75rem; background: var(--soft); border-radius: 6px;
  }

  .app { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  .topbar {
    display: flex; gap: 1rem; align-items: center;
    padding: .5rem 1rem; border-bottom: 1px solid var(--border);
  }
  .me { font-weight: 600; }
  .meter {
    flex: 1; max-width: 300px; height: 8px;
    background: var(--soft); border-radius: 4px; overflow: hidden;
  }
  .meter > span {
    display: block; height: 100%;
    background: linear-gradient(90deg, #16a34a, gold, #dc2626);
    transition: width 80ms linear;
  }
  .talking { font-size: .85rem; color: #888; flex: 1; text-align: right; }
  .topbar button { padding: .25rem .75rem; border-radius: 4px; border: 1px solid var(--border); background: transparent; cursor: pointer; }

  .panes { display: grid; grid-template-columns: 280px 1fr 280px; min-height: 0; }
  .panes > section { overflow-y: auto; padding: .75rem 1rem; }
  .panes > section + section { border-left: 1px solid var(--border); }
  h2.section {
    font-size: .75rem; text-transform: uppercase; letter-spacing: .05em;
    color: #888; margin: .25rem 0 .75rem 0;
  }

  ul.users { list-style: none; padding: 0; margin: 0; }
  ul.users li { display: flex; align-items: center; gap: .5rem; padding: .35rem 0; }
  .dot { width: .55rem; height: .55rem; border-radius: 50%; background: #aaa; flex-shrink: 0; }
  .dot.online { background: #16a34a; }
  .username { flex: 1; }
  .username.self { color: #888; font-style: italic; }

  button.ptt {
    font-size: .8rem; padding: .25rem .6rem; border-radius: 4px;
    border: 1px solid var(--border); background: transparent;
    user-select: none; touch-action: none; min-width: 50px; cursor: pointer; font: inherit;
  }
  button.ptt:disabled { opacity: .35; cursor: not-allowed; }
  button.ptt.active { background: #4f46e5; color: white; border-color: #4f46e5; }

  .groups { display: grid; gap: .75rem; }
  .group-card {
    border: 1px solid var(--border); border-radius: 8px; padding: .75rem 1rem;
    display: flex; flex-direction: column; gap: .4rem;
  }
  .group-card .head { display: flex; justify-content: space-between; align-items: center; }
  .group-card .name { font-weight: 600; text-transform: capitalize; }
  .group-card .members { font-size: .8rem; color: #888; }
  button.ptt-big {
    font-size: 1rem; padding: .75rem 1.25rem; border-radius: 6px;
    border: 1px solid #4f46e5; background: color-mix(in srgb, #4f46e5 18%, transparent);
    font-weight: 600; user-select: none; touch-action: none; cursor: pointer; font: inherit;
  }
  button.ptt-big.active { background: #4f46e5; color: white; }
  button.ptt-big:disabled { opacity: .4; cursor: not-allowed; }

  .rooms { display: flex; flex-direction: column; gap: .5rem; }
  .room { border: 1px solid var(--border); border-radius: 6px; padding: .5rem .75rem; }
  .room.entered { border-color: #4f46e5; }
  .room .head { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
  .room .name { font-weight: 600; text-transform: capitalize; }
  .room button {
    font-size: .8rem; padding: .2rem .55rem; border-radius: 4px;
    border: 1px solid var(--border); background: transparent; cursor: pointer; font: inherit;
  }
  .room button.talk.active {
    background: #4f46e5; color: white; border-color: #4f46e5;
  }
  .participants { font-size: .8rem; color: #888; margin-top: .25rem; }
</style>

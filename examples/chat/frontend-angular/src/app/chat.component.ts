import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { ChatService } from './chat.service';
import { isDmRoom, type RoomName } from './protocol';

/**
 * Three-column layout: rooms-panel (left), chat-window (center),
 * users-panel (right).  Uses signals from {@link ChatService} for
 * all state — no RxJS, no NgRx.
 */
@Component({
  selector: 'chat-room',
  standalone: true,
  styles: [`
    :host { height: 100vh; display: flex; flex-direction: column; }
    header.bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 1rem;
      border-bottom: 1px solid var(--border);
    }
    header.bar button {
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
    ul { list-style: none; margin: 0; padding: 0 0 0.5rem 0; overflow-y: auto; flex: 1; }
    ul.rooms li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.4rem 1rem;
      cursor: pointer;
      border-left: 3px solid transparent;
    }
    ul.rooms li.active {
      background: var(--soft);
      border-left-color: var(--accent);
      font-weight: 600;
    }
    ul.rooms li.dm span:first-child { font-style: italic; }
    ul.rooms li .badge {
      background: var(--accent);
      color: white;
      font-size: 0.7rem;
      padding: 0.05rem 0.4rem;
      border-radius: 999px;
    }
    ul.users li { padding: 0.4rem 1rem; cursor: pointer; }
    ul.users li.self { cursor: default; color: #888; }
    main { display: flex; flex-direction: column; min-height: 0; }
    .messages { flex: 1; overflow-y: auto; padding: 0.75rem 1rem; }
    .msg { margin-bottom: 0.4rem; }
    .from { font-weight: 600; margin-right: 0.4rem; }
    .ts { color: #888; font-size: 0.75rem; margin-left: 0.5rem; }
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
  `],
  template: `
    <header class="bar">
      <div><strong>actor-ts chat</strong> — {{ chat.username() }}</div>
      <button (click)="chat.logout()">Logout</button>
    </header>
    <div class="layout">
      <aside>
        <h2>Rooms</h2>
        <ul class="rooms">
          @for (room of chat.rooms(); track room) {
            <li
              [class.active]="room === chat.currentRoom()"
              [class.dm]="isDmRoom(room)"
              (click)="chat.selectRoom(room)"
            >
              <span>{{ isDmRoom(room) ? room : '# ' + room }}</span>
              @if (chat.unreadByRoom()[room] > 0) {
                <span class="badge">{{ chat.unreadByRoom()[room] }}</span>
              }
            </li>
          }
        </ul>
        <form class="room-create" (submit)="onCreateRoom($event)" autocomplete="off"
              title="Create a new room (a–z, 0–9, _-, 1–32 chars)">
          <input
            #roomCreateInput
            placeholder="+ new room"
            maxlength="32"
            [class.invalid]="createRoomInvalid()"
            (input)="createRoomInvalid.set(false)"
          />
          <button type="submit">Add</button>
        </form>
      </aside>
      <main>
        <div class="messages" #scroll>
          @for (m of chat.currentMessages(); track $index) {
            <div class="msg">
              <span class="from">{{ m.from }}:</span>{{ m.text }}
              <span class="ts">{{ formatTs(m.ts) }}</span>
            </div>
          }
        </div>
        <div class="typing">{{ typingText() }}</div>
        <!-- Plain (submit) + manual preventDefault. ngSubmit would only -->
        <!-- do that for us if the component imported FormsModule, and we -->
        <!-- don't need the rest of FormsModule here (we use viewChild   -->
        <!-- instead of ngModel).  Without preventDefault the native     -->
        <!-- form-submit reloads the whole page.                         -->
        <form class="compose" (submit)="onSend($event)">
          <input
            #composeInput
            placeholder="Type a message..."
            autocomplete="off"
            (input)="onComposeInput()"
          />
          <button type="submit">Send</button>
        </form>
      </main>
      <aside>
        <h2>Online ({{ displayedUsers().length }})</h2>
        <ul class="users">
          @for (u of displayedUsers(); track u) {
            <li
              [class.self]="u === chat.username()"
              [title]="u === chat.username() ? '' : 'Click to message @' + u"
              (click)="u === chat.username() ? null : chat.openDm(u)"
            >
              {{ u }}{{ u === chat.username() ? ' (you)' : '' }}
            </li>
          }
        </ul>
      </aside>
    </div>
  `,
})
export class ChatComponent {
  protected readonly chat = inject(ChatService);
  private readonly composeInput = viewChild.required<ElementRef<HTMLInputElement>>('composeInput');
  private readonly roomCreateInput = viewChild.required<ElementRef<HTMLInputElement>>('roomCreateInput');
  /** Bound to the new-room input's `.invalid` class — flipped on
   *  failed validation, cleared on the next keystroke. */
  protected readonly createRoomInvalid = signal(false);

  /** Re-exported as a template-callable so the template can flag DM
   *  list items without importing the helper itself. */
  protected readonly isDmRoom = isDmRoom;

  /** Users to display in the Online panel.  In a default room this is
   *  the cluster-known presence list; in a DM "room" there's no
   *  `users` frame from the server, so we synthesize a two-person
   *  list from the room name. */
  protected readonly displayedUsers = (): ReadonlyArray<string> => {
    const room = this.chat.currentRoom();
    const list = this.chat.currentUsers();
    if (room && isDmRoom(room) && list.length === 0) {
      const me = this.chat.username();
      return me ? [room.slice(1), me] : [room.slice(1)];
    }
    return list;
  };

  /** Rendered "X is typing…" line below the compose input. */
  protected readonly typingText = computed(() => {
    const peers = this.chat.currentTyping();
    if (peers.length === 0) return '';
    if (peers.length === 1) return `${peers[0]} is typing…`;
    if (peers.length === 2) return `${peers[0]} and ${peers[1]} are typing…`;
    return `${peers.length} people are typing…`;
  });

  protected formatTs(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  protected onComposeInput(): void {
    const room = this.chat.currentRoom() as RoomName | null;
    if (!room) return;
    this.chat.notifyTyping(room);
  }

  protected onSend(event: Event): void {
    event.preventDefault();
    const room = this.chat.currentRoom() as RoomName | null;
    if (!room) return;
    const input = this.composeInput().nativeElement;
    const text = input.value.trim();
    if (!text) return;
    this.chat.send(room, text);
    input.value = '';
  }

  protected onCreateRoom(event: Event): void {
    event.preventDefault();
    const input = this.roomCreateInput().nativeElement;
    const name = input.value.trim();
    if (!this.chat.createRoom(name)) {
      this.createRoomInvalid.set(true);
      return;
    }
    this.createRoomInvalid.set(false);
    input.value = '';
  }
}

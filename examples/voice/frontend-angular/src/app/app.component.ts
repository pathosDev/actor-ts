import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { VoiceService } from './voice.service';
import type { ClientMessage } from './protocol';

/**
 * Root component for the voice sample.  Same three-pane shape as
 * the chat sample's Angular root, swapped for voice modes:
 *
 *   - gate-mic    →  Enable mic button (mic permission +
 *                    AudioContext unlock).
 *   - gate-login  →  classic credentials form.
 *   - app         →  user list (peer PTT) / group cards (group PTT) /
 *                    room panels (enter + open-mic toggle).
 *
 * State lives in `VoiceService`; this component is a binding layer
 * over its signals.  Per-PTT pointer events go through the service
 * which manages MediaRecorder + WebSocket I/O.
 */
@Component({
  selector: 'voice-root',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (v.phase() === 'gate-mic') {
      <div class="gate">
        <h1>actor-ts voice</h1>
        <p class="hint">Click "Enable mic" once.  Grants the mic permission AND unlocks
          the AudioContext for inbound playback.</p>
        <button class="primary" type="button" (click)="v.enableMic()">Enable mic</button>
        <div class="err">{{ v.loginError() }}</div>
      </div>
    } @else if (v.phase() === 'gate-login') {
      <div class="gate">
        <h1>actor-ts voice</h1>
        <p class="hint">Pick a user.  Passwords visible below.</p>
        <form (submit)="onLogin($event)" autocomplete="off">
          <input [(ngModel)]="usernameInput" name="username" placeholder="username" required />
          <input [(ngModel)]="passwordInput" name="password" type="password" placeholder="password" required />
          <button class="primary" type="submit">Log in</button>
          <div class="err">{{ v.loginError() }}</div>
        </form>
        <div class="creds">
          <strong>Test users</strong> (visible by design):
          <code>alice</code>/<code>wonderland</code>,
          <code>bob</code>/<code>builder</code>,
          <code>charlie</code>/<code>chaplin</code>,
          <code>diana</code>/<code>prince</code>.
        </div>
      </div>
    } @else {
      <div class="app">
        <header class="topbar">
          <div class="me">{{ v.username() }}</div>
          <div class="meter"><span [style.width.%]="v.micPct()"></span></div>
          <div class="talking">
            @if (v.incomingNames().length === 0) { no incoming audio }
            @else { 🔊 {{ v.incomingNames().join(' · ') }} }
          </div>
          <button (click)="v.logout()">Logout</button>
        </header>
        <div class="panes">
          <section>
            <h2 class="section">Users</h2>
            <ul class="users">
              @for (u of v.directory().users; track u) {
                <li>
                  <span class="dot" [class.online]="v.onlineUsers().has(u)"></span>
                  <span class="username" [class.self]="u === v.username()">{{ u }}</span>
                  @if (u !== v.username()) {
                    <button class="ptt" [class.active]="v.activeKey() === ('peer:' + u)"
                            [disabled]="!v.onlineUsers().has(u)"
                            (pointerdown)="onPress($event, { type: 'voice-target', mode: 'peer', target: u }, 'peer:' + u)"
                            (pointerup)="onRelease($event, 'peer:' + u)"
                            (pointercancel)="onRelease($event, 'peer:' + u)"
                            (pointerleave)="onPointerLeave($event, 'peer:' + u)">PTT</button>
                  }
                </li>
              }
            </ul>
          </section>
          <section>
            <h2 class="section">Groups</h2>
            <div class="groups">
              @for (g of v.directory().groups; track g.name) {
                <div class="group-card">
                  <div class="head"><span class="name">{{ g.name }}</span></div>
                  <div class="members">{{ g.members.join(', ') }}</div>
                  <button class="ptt-big" [class.active]="v.activeKey() === ('group:' + g.name)"
                          [disabled]="!g.members.includes(v.username() ?? '')"
                          [title]="g.members.includes(v.username() ?? '') ? '' : 'You are not a member of this group.'"
                          (pointerdown)="onPress($event, { type: 'voice-target', mode: 'group', group: g.name }, 'group:' + g.name)"
                          (pointerup)="onRelease($event, 'group:' + g.name)"
                          (pointercancel)="onRelease($event, 'group:' + g.name)"
                          (pointerleave)="onPointerLeave($event, 'group:' + g.name)">Hold to talk</button>
                </div>
              }
            </div>
          </section>
          <section>
            <h2 class="section">Rooms</h2>
            <div class="rooms">
              @for (r of v.directory().rooms; track r) {
                <div class="room" [class.entered]="v.joinedRooms().has(r)">
                  <div class="head">
                    <span class="name">{{ r }}</span>
                    @if (v.joinedRooms().has(r)) {
                      <button class="talk" [class.active]="v.roomTalking().has(r)"
                              (click)="v.toggleRoomTalk(r)">{{ v.roomTalking().has(r) ? 'Stop' : 'Talk' }}</button>
                      <button class="leave" (click)="v.leaveRoom(r)">Leave</button>
                    } @else {
                      <button class="enter" (click)="v.enterRoom(r)">Enter</button>
                    }
                  </div>
                  <div class="participants">
                    @if ((v.roomParticipants().get(r) ?? []).length === 0) { — empty — }
                    @else { {{ (v.roomParticipants().get(r) ?? []).join(', ') }} }
                  </div>
                </div>
              }
            </div>
          </section>
        </div>
      </div>
    }
  `,
})
export class AppComponent {
  protected readonly v = inject(VoiceService);
  protected usernameInput = signal('');
  protected passwordInput = signal('');

  protected onLogin(e: SubmitEvent): void {
    e.preventDefault();
    const u = this.usernameInput().trim();
    const p = this.passwordInput();
    if (!u || !p) return;
    this.v.login(u, p);
  }

  protected onPress(e: PointerEvent, target: ClientMessage & { type: 'voice-target' }, key: string): void {
    e.preventDefault();
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.disabled) return;
    this.v.beginPress(target, key);
    try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  protected onRelease(e: PointerEvent, key: string): void {
    e.preventDefault();
    this.v.endPress(key);
  }

  protected onPointerLeave(e: PointerEvent, key: string): void {
    if (this.v.activeKey() !== key) return;
    this.onRelease(e, key);
  }
}

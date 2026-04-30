import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatService } from './chat.service';

@Component({
  selector: 'chat-login',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      width: 280px;
      margin-top: 1rem;
    }
    input, button {
      padding: 0.5rem 0.75rem;
      font: inherit;
      border-radius: 4px;
      border: 1px solid var(--border);
    }
    button {
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
    code { background: var(--border); padding: 0 0.25rem; border-radius: 3px; }
    .lead { color: #888; margin: 0; }
  `],
  template: `
    <h1>actor-ts chat</h1>
    <p class="lead">Angular frontend</p>
    <form (ngSubmit)="onSubmit()" autocomplete="off">
      <input name="username" [(ngModel)]="username" placeholder="username" required />
      <input name="password" type="password" [(ngModel)]="password" placeholder="password" required />
      <button type="submit">Log in</button>
      <div class="err">{{ chat.loginError() }}</div>
    </form>
    <div class="creds">
      <strong>Test users</strong>:
      <code>alice</code>/<code>wonderland</code>,
      <code>bob</code>/<code>builder</code>,
      <code>charlie</code>/<code>chaplin</code>,
      <code>diana</code>/<code>prince</code>
    </div>
  `,
})
export class LoginComponent {
  protected readonly chat = inject(ChatService);
  protected username = '';
  protected password = '';

  protected onSubmit(): void {
    if (!this.username.trim() || !this.password) return;
    this.chat.connect(this.username.trim(), this.password);
  }
}

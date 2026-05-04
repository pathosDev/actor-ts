import { Component, inject } from '@angular/core';
import { ChatService } from './chat.service';
import { LoginComponent } from './login.component';
import { ChatComponent } from './chat.component';

/**
 * Root component — switches between the login and chat views based
 * on `ChatService.phase()`.  In the 'resuming' phase we render
 * nothing: that's the brief window after a page reload when the
 * stored token is being re-validated by the server.  Rendering
 * the login form there would cause a visible flash before the
 * server replies with `logged-in`.  All real work lives in the
 * child components and the service.
 */
@Component({
  selector: 'chat-root',
  standalone: true,
  imports: [LoginComponent, ChatComponent],
  template: `
    @if (chat.phase() === 'login') {
      <chat-login />
    } @else if (chat.phase() === 'chat') {
      <chat-room />
    }
  `,
})
export class AppComponent {
  protected readonly chat = inject(ChatService);
}

import { Component, inject } from '@angular/core';
import { ChatService } from './chat.service';
import { LoginComponent } from './login.component';
import { ChatComponent } from './chat.component';

/**
 * Root component — switches between the login and chat views based
 * on `ChatService.phase()`.  All real work lives in the child
 * components and the service.
 */
@Component({
  selector: 'chat-root',
  standalone: true,
  imports: [LoginComponent, ChatComponent],
  template: `
    @if (chat.phase() === 'login') {
      <chat-login />
    } @else {
      <chat-room />
    }
  `,
})
export class AppComponent {
  protected readonly chat = inject(ChatService);
}

import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';

void bootstrapApplication(AppComponent).catch((err: unknown) =>
  console.error('Failed to bootstrap actor-ts voice:', err),
);

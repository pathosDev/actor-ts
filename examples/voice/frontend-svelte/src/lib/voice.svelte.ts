/**
 * Svelte-5-Runes-based voice store.  Lifted state for the SvelteKit
 * frontend; analog of `chat.svelte.ts` in the chat sample.
 *
 * The audio plumbing — `MediaRecorder` capture per press,
 * `MediaSource` per inbound sender, frame-codec demux of binary
 * WS frames — is identical across all six voice frontends.  This
 * file's only job is to thread that plumbing through Svelte's
 * runes so the UI re-renders when state changes.
 *
 * The `.svelte.ts` extension is what tells the Svelte compiler to
 * lift `$state(...)` into reactive primitives; using `.ts` here
 * would render the runes inert.
 */

import {
  WS_PATH, TIMESLICE_MS, MIME_OPUS,
  decodeIncomingFrame,
  type ClientMessage, type ServerMessage,
  type GroupName, type GroupSummary, type IncomingSource, type Username, type VoiceRoomName,
} from './protocol';

const TOKEN_KEY = 'voice-token';
const MAX_RECONNECT_ATTEMPTS = 8;

type Phase = 'gate-mic' | 'gate-login' | 'app';

interface IncomingEntry {
  mediaSource: MediaSource;
  sourceBuffer: SourceBuffer | null;
  audioEl: HTMLAudioElement;
  // The queue holds copies created via `new Uint8Array(byteLength)` — those are
  // always backed by a plain `ArrayBuffer`, never `SharedArrayBuffer`.  Without
  // pinning the generic, strict-TS builds reject `appendBuffer(item)` because
  // the wider `Uint8Array<ArrayBufferLike>` could (in principle) be a SAB view.
  queue: Uint8Array<ArrayBuffer>[];
  mimeReady: boolean;
  source: IncomingSource;
  objectUrl: string;
}

class VoiceStore {
  // Phase machine + auth state
  phase = $state<Phase>('gate-mic');
  username = $state<string | null>(null);
  loginError = $state('');

  // Server-pushed snapshots
  directory = $state<{ users: Username[]; groups: GroupSummary[]; rooms: VoiceRoomName[] }>({
    users: [], groups: [], rooms: [],
  });
  onlineUsers = $state<Set<string>>(new Set());
  roomParticipants = $state<Map<VoiceRoomName, string[]>>(new Map());

  // Local UI state
  joinedRooms = $state<Set<VoiceRoomName>>(new Set());
  roomTalking = $state<Set<VoiceRoomName>>(new Set());
  activeKey = $state<string | null>(null);
  incomingNames = $state<string[]>([]);
  micPct = $state(0);

  // Non-reactive plumbing
  #ws: WebSocket | null = null;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #micStream: MediaStream | null = null;
  #micRecorder: MediaRecorder | null = null;
  #micCtx: AudioContext | null = null;
  #micAnalyser: AnalyserNode | null = null;
  #incoming = new Map<string, IncomingEntry>();

  /* ----------------------------- mic init ---------------------------- */

  async enableMic(): Promise<void> {
    try {
      this.#micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === 'suspended') await ctx.resume();
      this.#micCtx = ctx;
      const src = ctx.createMediaStreamSource(this.#micStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.#micAnalyser = analyser;
      this.#tickMeter();

      this.phase = 'gate-login';
      const stored = sessionStorage.getItem(TOKEN_KEY);
      if (stored) this.#connect((ws) => ws.send(JSON.stringify({ kind: 'resume', token: stored } satisfies ClientMessage)));
    } catch (e) {
      this.loginError = `Microphone access denied (${(e as Error)?.message ?? e}).`;
    }
  }

  #tickMeter(): void {
    if (!this.#micAnalyser) return;
    const data = new Uint8Array(this.#micAnalyser.frequencyBinCount);
    const tick = (): void => {
      if (!this.#micAnalyser) return;
      this.#micAnalyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const b of data) { const dev = Math.abs(b - 128); if (dev > peak) peak = dev; }
      this.micPct = Math.min(100, (peak / 64) * 100);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ------------------------------ auth -------------------------------- */

  login(username: string, password: string): void {
    this.loginError = '';
    this.#connect((ws) => ws.send(JSON.stringify({ kind: 'login', username, password } satisfies ClientMessage)));
  }

  logout(): void {
    try { this.#ws?.send(JSON.stringify({ kind: 'logout' } satisfies ClientMessage)); } catch { /* ignore */ }
    sessionStorage.removeItem(TOKEN_KEY);
    location.reload();
  }

  /* --------------------------- websocket plumbing ---------------------- */

  #connect(onOpen: (ws: WebSocket) => void): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    ws.addEventListener('open', () => onOpen(ws));
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') this.#onText(ev.data);
      else this.#onBinary(new Uint8Array(ev.data as ArrayBuffer));
    });
    ws.addEventListener('close', () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (!this.#scheduleResume() && this.phase === 'app') this.#resetToGate();
    });
    ws.addEventListener('error', () => {
      if (this.phase === 'gate-login' && !sessionStorage.getItem(TOKEN_KEY)) {
        this.loginError = 'Connection failed.';
      }
    });
  }

  #scheduleResume(): boolean {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token || this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return false;
    const delay = Math.min(500 * Math.pow(2, this.#reconnectAttempts), 4000);
    this.#reconnectAttempts++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect((ws) => ws.send(JSON.stringify({ kind: 'resume', token } satisfies ClientMessage)));
    }, delay);
    return true;
  }

  #cancelReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#reconnectAttempts = 0;
  }

  #resetToGate(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    location.reload();
  }

  #onText(raw: string): void {
    let m: ServerMessage;
    try { m = JSON.parse(raw) as ServerMessage; } catch { return; }
    switch (m.kind) {
      case 'logged-in':
        this.#cancelReconnect();
        this.username = m.username;
        sessionStorage.setItem(TOKEN_KEY, m.token);
        this.phase = 'app';
        break;
      case 'login-failed':
        this.#cancelReconnect();
        sessionStorage.removeItem(TOKEN_KEY);
        try { this.#ws?.close(); } catch { /* ignore */ }
        this.#ws = null;
        if (this.phase === 'app') this.#resetToGate();
        else this.loginError = m.reason || 'Login failed';
        break;
      case 'directory':
        this.directory = {
          users: [...m.users],
          groups: m.groups.map((g) => ({ name: g.name, members: [...g.members] })),
          rooms: [...m.rooms],
        };
        break;
      case 'online-users':
        this.onlineUsers = new Set(m.users);
        break;
      case 'room-participants': {
        const next = new Map(this.roomParticipants);
        next.set(m.room, [...m.users]);
        this.roomParticipants = next;
        break;
      }
      case 'voice-target-ok': /* ack */ break;
      case 'voice-target-failed':
        // Press-down failed; clear active highlight.
        this.activeKey = null;
        break;
      case 'voice-incoming-start':
        this.#startIncoming(m.from, m.source);
        break;
      case 'voice-incoming-end':
        this.#endIncoming(m.from);
        break;
      case 'system':
        break;
    }
  }

  #onBinary(buf: Uint8Array): void {
    const decoded = decodeIncomingFrame(buf);
    if (!decoded) return;
    this.#feedIncoming(decoded.sender, decoded.opus);
  }

  /* --------------------------- press / talk ---------------------------- */

  beginPress(target: ClientMessage & { kind: 'voice-target' }, key: string): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    if (this.activeKey) this.#endActive();
    this.activeKey = key;
    this.#ws.send(JSON.stringify(target));
    this.#startMicRecording();
  }

  endPress(key: string): void {
    if (this.activeKey !== key) return;
    this.#endActive();
  }

  #endActive(): void {
    this.#stopMicRecording();
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ kind: 'voice-stop' } satisfies ClientMessage));
    }
    this.activeKey = null;
  }

  toggleRoomTalk(room: VoiceRoomName): void {
    const next = new Set(this.roomTalking);
    if (next.has(room)) {
      next.delete(room);
      this.#endActive();
    } else {
      next.add(room);
      this.activeKey = `room:${room}`;
      this.#ws?.send(JSON.stringify({ kind: 'voice-target', mode: 'room', room } satisfies ClientMessage));
      this.#startMicRecording();
    }
    this.roomTalking = next;
  }

  enterRoom(room: VoiceRoomName): void {
    const next = new Set(this.joinedRooms);
    next.add(room); this.joinedRooms = next;
    this.#ws?.send(JSON.stringify({ kind: 'room-enter', room } satisfies ClientMessage));
  }

  leaveRoom(room: VoiceRoomName): void {
    if (this.roomTalking.has(room)) this.toggleRoomTalk(room);
    const next = new Set(this.joinedRooms);
    next.delete(room); this.joinedRooms = next;
    this.#ws?.send(JSON.stringify({ kind: 'room-leave', room } satisfies ClientMessage));
  }

  /* ------------------------------ mic IO ------------------------------- */

  #startMicRecording(): void {
    this.#stopMicRecording();
    if (!this.#micStream) return;
    const rec = new MediaRecorder(this.#micStream, { mimeType: MIME_OPUS });
    rec.addEventListener('dataavailable', async (e) => {
      if (!e.data || e.data.size === 0) return;
      if (this.#ws?.readyState !== WebSocket.OPEN) return;
      try { this.#ws.send(await e.data.arrayBuffer()); } catch (err) { console.warn(err); }
    });
    rec.start(TIMESLICE_MS);
    this.#micRecorder = rec;
  }

  #stopMicRecording(): void {
    if (!this.#micRecorder) return;
    try { this.#micRecorder.stop(); } catch { /* ignore */ }
    this.#micRecorder = null;
  }

  /* ----------------------------- playback ----------------------------- */

  #startIncoming(from: string, source: IncomingSource): void {
    if (this.#incoming.has(from)) this.#endIncoming(from);
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    const ms = new MediaSource();
    audioEl.src = URL.createObjectURL(ms);
    document.body.appendChild(audioEl);
    const entry: IncomingEntry = {
      mediaSource: ms, sourceBuffer: null, audioEl, queue: [],
      mimeReady: false, source, objectUrl: audioEl.src,
    };
    this.#incoming.set(from, entry);
    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer(MIME_OPUS);
        sb.mode = 'sequence';
        sb.addEventListener('updateend', () => this.#drainQueue(entry));
        entry.sourceBuffer = sb; entry.mimeReady = true;
        this.#drainQueue(entry);
      } catch (e) { console.warn('addSourceBuffer', e); }
    });
    this.#refreshIncomingNames();
  }

  #feedIncoming(from: string, opus: Uint8Array): void {
    const entry = this.#incoming.get(from);
    if (!entry) return;
    const copy = new Uint8Array(opus.byteLength); copy.set(opus);
    entry.queue.push(copy);
    this.#drainQueue(entry);
  }

  #drainQueue(entry: IncomingEntry): void {
    if (!entry.mimeReady || !entry.sourceBuffer || entry.sourceBuffer.updating) return;
    const next = entry.queue.shift();
    if (!next) return;
    try { entry.sourceBuffer.appendBuffer(next); } catch (e) { console.warn(e); }
  }

  #endIncoming(from: string): void {
    const entry = this.#incoming.get(from);
    if (!entry) return;
    this.#incoming.delete(from);
    this.#refreshIncomingNames();
    try {
      if (entry.sourceBuffer && !entry.sourceBuffer.updating) entry.mediaSource.endOfStream();
    } catch { /* ignore */ }
    setTimeout(() => {
      try { URL.revokeObjectURL(entry.objectUrl); } catch { /* ignore */ }
      try { entry.audioEl.remove(); } catch { /* ignore */ }
    }, 1500);
  }

  #refreshIncomingNames(): void {
    const names: string[] = [];
    for (const [name, entry] of this.#incoming) {
      const src = entry.source;
      if (src?.kind === 'group') names.push(`${name} (group: ${src.group})`);
      else if (src?.kind === 'room') names.push(`${name} (room: ${src.room})`);
      else names.push(name);
    }
    this.incomingNames = names;
  }
}

export const voice = new VoiceStore();

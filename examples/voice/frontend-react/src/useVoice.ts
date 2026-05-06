/**
 * `useVoice` — owns the WebSocket, mic capture, per-sender
 * playback, and all server-pushed state for the voice React
 * frontend.  Analog of `useChat` in the chat sample.
 *
 * Single source of truth pattern: a reducer holds reactive state
 * (presence sets, joined/talking rooms, incoming-speaker labels);
 * imperative side effects (WebSocket, MediaRecorder, MediaSource
 * objects) live behind refs so React renders don't re-create them.
 *
 * The audio plumbing is identical to the plain HTML reference;
 * only the wrapping (refs + dispatch) is React-shaped.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  WS_PATH, TIMESLICE_MS, MIME_OPUS,
  decodeIncomingFrame,
  type ClientMessage, type ServerMessage,
  type GroupSummary, type IncomingSource, type Username, type VoiceRoomName,
} from './protocol';

const TOKEN_KEY = 'voice-token';
const MAX_RECONNECT_ATTEMPTS = 8;

export type Phase = 'gate-mic' | 'gate-login' | 'app';

interface State {
  readonly phase: Phase;
  readonly username: string | null;
  readonly loginError: string;
  readonly directory: { users: ReadonlyArray<Username>; groups: ReadonlyArray<GroupSummary>; rooms: ReadonlyArray<VoiceRoomName> };
  readonly onlineUsers: ReadonlySet<string>;
  readonly roomParticipants: ReadonlyMap<VoiceRoomName, ReadonlyArray<string>>;
  readonly joinedRooms: ReadonlySet<VoiceRoomName>;
  readonly roomTalking: ReadonlySet<VoiceRoomName>;
  readonly activeKey: string | null;
  readonly incomingNames: ReadonlyArray<string>;
  readonly micPct: number;
}

const INITIAL: State = {
  phase: 'gate-mic',
  username: null,
  loginError: '',
  directory: { users: [], groups: [], rooms: [] },
  onlineUsers: new Set(),
  roomParticipants: new Map(),
  joinedRooms: new Set(),
  roomTalking: new Set(),
  activeKey: null,
  incomingNames: [],
  micPct: 0,
};

type Action =
  | { type: 'phase'; phase: Phase }
  | { type: 'login-error'; reason: string }
  | { type: 'logged-in'; username: string }
  | { type: 'directory'; payload: State['directory'] }
  | { type: 'online'; users: ReadonlyArray<string> }
  | { type: 'room-participants'; room: VoiceRoomName; users: ReadonlyArray<string> }
  | { type: 'set-joined'; rooms: ReadonlyArray<VoiceRoomName> }
  | { type: 'set-talking'; rooms: ReadonlyArray<VoiceRoomName> }
  | { type: 'active-key'; key: string | null }
  | { type: 'incoming-names'; names: ReadonlyArray<string> }
  | { type: 'mic-pct'; pct: number };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'phase':              return { ...state, phase: action.phase };
    case 'login-error':        return { ...state, loginError: action.reason };
    case 'logged-in':          return { ...state, phase: 'app', username: action.username, loginError: '' };
    case 'directory':          return { ...state, directory: action.payload };
    case 'online':             return { ...state, onlineUsers: new Set(action.users) };
    case 'room-participants': {
      const next = new Map(state.roomParticipants);
      next.set(action.room, [...action.users]);
      return { ...state, roomParticipants: next };
    }
    case 'set-joined':         return { ...state, joinedRooms: new Set(action.rooms) };
    case 'set-talking':        return { ...state, roomTalking: new Set(action.rooms) };
    case 'active-key':         return { ...state, activeKey: action.key };
    case 'incoming-names':     return { ...state, incomingNames: [...action.names] };
    case 'mic-pct':            return { ...state, micPct: action.pct };
  }
}

interface IncomingEntry {
  mediaSource: MediaSource;
  sourceBuffer: SourceBuffer | null;
  audioEl: HTMLAudioElement;
  // The queue holds copies created via `new Uint8Array(byteLength)` — those are
  // always backed by a plain `ArrayBuffer`, never `SharedArrayBuffer`.  Without
  // pinning the generic, strict-TS builds (Next.js / Angular) reject
  // `appendBuffer(item)` because the wider `Uint8Array<ArrayBufferLike>` could
  // (in principle) be a SAB view.
  queue: Uint8Array<ArrayBuffer>[];
  mimeReady: boolean;
  source: IncomingSource;
  objectUrl: string;
}

export function useVoice(): {
  state: State;
  enableMic(): Promise<void>;
  login(username: string, password: string): void;
  logout(): void;
  beginPress(target: ClientMessage & { type: 'voice-target' }, key: string): void;
  endPress(key: string): void;
  toggleRoomTalk(room: VoiceRoomName): void;
  enterRoom(room: VoiceRoomName): void;
  leaveRoom(room: VoiceRoomName): void;
} {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  // Refs for non-reactive plumbing.
  const wsRef = useRef<WebSocket | null>(null);
  const reconAttempts = useRef(0);
  const reconTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const micRecorder = useRef<MediaRecorder | null>(null);
  const micCtx = useRef<AudioContext | null>(null);
  const micAnalyser = useRef<AnalyserNode | null>(null);
  const incoming = useRef(new Map<string, IncomingEntry>());

  /* --------------------------- WS plumbing --------------------------- */

  const handleText = useCallback((raw: string) => {
    let m: ServerMessage;
    try { m = JSON.parse(raw) as ServerMessage; } catch { return; }
    switch (m.type) {
      case 'logged-in':
        cancelReconnect();
        sessionStorage.setItem(TOKEN_KEY, m.token);
        dispatch({ type: 'logged-in', username: m.username });
        break;
      case 'login-failed':
        cancelReconnect();
        sessionStorage.removeItem(TOKEN_KEY);
        try { wsRef.current?.close(); } catch { /* ignore */ }
        wsRef.current = null;
        dispatch({ type: 'login-error', reason: m.reason || 'Login failed' });
        dispatch({ type: 'phase', phase: 'gate-login' });
        break;
      case 'directory':
        dispatch({ type: 'directory', payload: {
          users: [...m.users], groups: m.groups.map((g) => ({ name: g.name, members: [...g.members] })),
          rooms: [...m.rooms],
        }});
        break;
      case 'online-users':
        dispatch({ type: 'online', users: m.users });
        break;
      case 'room-participants':
        dispatch({ type: 'room-participants', room: m.room, users: m.users });
        break;
      case 'voice-target-failed':
        dispatch({ type: 'active-key', key: null });
        break;
      case 'voice-incoming-start':
        startIncoming(m.from, m.source);
        break;
      case 'voice-incoming-end':
        endIncoming(m.from);
        break;
      case 'voice-target-ok':
      case 'system':
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelReconnect = useCallback(() => {
    if (reconTimer.current) clearTimeout(reconTimer.current);
    reconTimer.current = null;
    reconAttempts.current = 0;
  }, []);

  const scheduleResume = useCallback((): boolean => {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token || reconAttempts.current >= MAX_RECONNECT_ATTEMPTS) return false;
    const delay = Math.min(500 * Math.pow(2, reconAttempts.current), 4000);
    reconAttempts.current++;
    reconTimer.current = setTimeout(() => {
      reconTimer.current = null;
      connect((ws) => ws.send(JSON.stringify({ type: 'resume', token } satisfies ClientMessage)));
    }, delay);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback((onOpen: (ws: WebSocket) => void) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    ws.addEventListener('open', () => onOpen(ws));
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') handleText(ev.data);
      else {
        const decoded = decodeIncomingFrame(new Uint8Array(ev.data as ArrayBuffer));
        if (decoded) feedIncoming(decoded.sender, decoded.opus);
      }
    });
    ws.addEventListener('close', () => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      if (!scheduleResume() && state.phase === 'app') {
        sessionStorage.removeItem(TOKEN_KEY);
        location.reload();
      }
    });
    ws.addEventListener('error', () => {
      if (state.phase === 'gate-login' && !sessionStorage.getItem(TOKEN_KEY)) {
        dispatch({ type: 'login-error', reason: 'Connection failed.' });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleText, scheduleResume, state.phase]);

  /* ---------------------------- mic init ----------------------------- */

  const enableMic = useCallback(async () => {
    try {
      micStream.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === 'suspended') await ctx.resume();
      micCtx.current = ctx;
      const src = ctx.createMediaStreamSource(micStream.current);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      micAnalyser.current = analyser;
      // Start meter loop.
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = (): void => {
        if (!micAnalyser.current) return;
        micAnalyser.current.getByteTimeDomainData(data);
        let peak = 0;
        for (const b of data) { const dev = Math.abs(b - 128); if (dev > peak) peak = dev; }
        dispatch({ type: 'mic-pct', pct: Math.min(100, (peak / 64) * 100) });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      dispatch({ type: 'phase', phase: 'gate-login' });
      const stored = sessionStorage.getItem(TOKEN_KEY);
      if (stored) connect((ws) => ws.send(JSON.stringify({ type: 'resume', token: stored } satisfies ClientMessage)));
    } catch (e) {
      dispatch({ type: 'login-error', reason: `Microphone access denied (${(e as Error)?.message ?? e}).` });
    }
  }, [connect]);

  const login = useCallback((username: string, password: string) => {
    dispatch({ type: 'login-error', reason: '' });
    connect((ws) => ws.send(JSON.stringify({ type: 'login', username, password } satisfies ClientMessage)));
  }, [connect]);

  const logout = useCallback(() => {
    try { wsRef.current?.send(JSON.stringify({ type: 'logout' } satisfies ClientMessage)); } catch { /* ignore */ }
    sessionStorage.removeItem(TOKEN_KEY);
    location.reload();
  }, []);

  /* --------------------------- press / talk -------------------------- */

  const startMicRecording = useCallback(() => {
    if (micRecorder.current) {
      try { micRecorder.current.stop(); } catch { /* ignore */ }
      micRecorder.current = null;
    }
    if (!micStream.current) return;
    const rec = new MediaRecorder(micStream.current, { mimeType: MIME_OPUS });
    rec.addEventListener('dataavailable', async (e) => {
      if (!e.data || e.data.size === 0) return;
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      try { wsRef.current.send(await e.data.arrayBuffer()); } catch (err) { console.warn(err); }
    });
    rec.start(TIMESLICE_MS);
    micRecorder.current = rec;
  }, []);

  const stopMicRecording = useCallback(() => {
    if (!micRecorder.current) return;
    try { micRecorder.current.stop(); } catch { /* ignore */ }
    micRecorder.current = null;
  }, []);

  const endActive = useCallback(() => {
    stopMicRecording();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'voice-stop' } satisfies ClientMessage));
    }
    dispatch({ type: 'active-key', key: null });
  }, [stopMicRecording]);

  const beginPress = useCallback((target: ClientMessage & { type: 'voice-target' }, key: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (state.activeKey) endActive();
    dispatch({ type: 'active-key', key });
    wsRef.current.send(JSON.stringify(target));
    startMicRecording();
  }, [state.activeKey, startMicRecording, endActive]);

  const endPress = useCallback((key: string) => {
    if (state.activeKey !== key) return;
    endActive();
  }, [state.activeKey, endActive]);

  const toggleRoomTalk = useCallback((room: VoiceRoomName) => {
    const rooms = new Set(state.roomTalking);
    if (rooms.has(room)) {
      rooms.delete(room);
      endActive();
    } else {
      rooms.add(room);
      dispatch({ type: 'active-key', key: `room:${room}` });
      wsRef.current?.send(JSON.stringify({ type: 'voice-target', mode: 'room', room } satisfies ClientMessage));
      startMicRecording();
    }
    dispatch({ type: 'set-talking', rooms: [...rooms] });
  }, [state.roomTalking, endActive, startMicRecording]);

  const enterRoom = useCallback((room: VoiceRoomName) => {
    const rooms = new Set(state.joinedRooms);
    rooms.add(room);
    dispatch({ type: 'set-joined', rooms: [...rooms] });
    wsRef.current?.send(JSON.stringify({ type: 'room-enter', room } satisfies ClientMessage));
  }, [state.joinedRooms]);

  const leaveRoom = useCallback((room: VoiceRoomName) => {
    if (state.roomTalking.has(room)) toggleRoomTalk(room);
    const rooms = new Set(state.joinedRooms);
    rooms.delete(room);
    dispatch({ type: 'set-joined', rooms: [...rooms] });
    wsRef.current?.send(JSON.stringify({ type: 'room-leave', room } satisfies ClientMessage));
  }, [state.joinedRooms, state.roomTalking, toggleRoomTalk]);

  /* ----------------------------- playback ---------------------------- */

  function refreshIncomingNames(): void {
    const names: string[] = [];
    for (const [name, entry] of incoming.current) {
      const src = entry.source;
      if (src?.kind === 'group') names.push(`${name} (group: ${src.group})`);
      else if (src?.kind === 'room') names.push(`${name} (room: ${src.room})`);
      else names.push(name);
    }
    dispatch({ type: 'incoming-names', names });
  }

  function startIncoming(from: string, source: IncomingSource): void {
    if (incoming.current.has(from)) endIncoming(from);
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true; audioEl.style.display = 'none';
    const ms = new MediaSource();
    audioEl.src = URL.createObjectURL(ms);
    document.body.appendChild(audioEl);
    const entry: IncomingEntry = {
      mediaSource: ms, sourceBuffer: null, audioEl, queue: [], mimeReady: false, source, objectUrl: audioEl.src,
    };
    incoming.current.set(from, entry);
    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer(MIME_OPUS);
        sb.mode = 'sequence';
        sb.addEventListener('updateend', () => drainQueue(entry));
        entry.sourceBuffer = sb; entry.mimeReady = true;
        drainQueue(entry);
      } catch (e) { console.warn(e); }
    });
    refreshIncomingNames();
  }

  function feedIncoming(from: string, opus: Uint8Array): void {
    const entry = incoming.current.get(from);
    if (!entry) return;
    const copy = new Uint8Array(opus.byteLength); copy.set(opus);
    entry.queue.push(copy);
    drainQueue(entry);
  }

  function drainQueue(entry: IncomingEntry): void {
    if (!entry.mimeReady || !entry.sourceBuffer || entry.sourceBuffer.updating) return;
    const next = entry.queue.shift();
    if (!next) return;
    try { entry.sourceBuffer.appendBuffer(next); } catch (e) { console.warn(e); }
  }

  function endIncoming(from: string): void {
    const entry = incoming.current.get(from);
    if (!entry) return;
    incoming.current.delete(from);
    refreshIncomingNames();
    try {
      if (entry.sourceBuffer && !entry.sourceBuffer.updating) entry.mediaSource.endOfStream();
    } catch { /* ignore */ }
    setTimeout(() => {
      try { URL.revokeObjectURL(entry.objectUrl); } catch { /* ignore */ }
      try { entry.audioEl.remove(); } catch { /* ignore */ }
    }, 1500);
  }

  /* ------------------------ unmount cleanup -------------------------- */

  useEffect(() => {
    return () => {
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
  }, []);

  return { state, enableMic, login, logout, beginPress, endPress, toggleRoomTalk, enterRoom, leaveRoom };
}

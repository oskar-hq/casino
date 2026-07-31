/**
 * WebSocket-Verbindung mit automatischem Wiederverbinden.
 *
 * Der Socket läuft über denselben Host und Port wie die Seite (`/ws`) – damit
 * funktioniert ein Cloudflare- oder Tailscale-Funnel ohne Extrakonfiguration.
 */

export class Net extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.queue = [];
    this.attempt = 0;
    this.manualClose = false;
    /** Wird vor jedem (Wieder-)Verbinden gefragt: liefert die Eintrittsnachricht. */
    this.resume = null;
  }

  get url() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    this.manualClose = false;
    const state = this.socket?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.emit('status', { online: true });
      const resumeMessage = this.resume?.();
      if (resumeMessage) socket.send(JSON.stringify(resumeMessage));
      for (const payload of this.queue.splice(0)) socket.send(JSON.stringify(payload));
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.emit('message', message);
      this.emit(message.type, message);
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.emit('status', { online: false });
      if (!this.manualClose) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => socket.close());
  }

  scheduleReconnect() {
    this.attempt += 1;
    const delay = Math.min(1000 * 2 ** (this.attempt - 1), 10000);
    setTimeout(() => this.connect(), delay);
  }

  send(payload) {
    if (this.connected) this.socket.send(JSON.stringify(payload));
    else {
      this.queue.push(payload);
      this.connect();
    }
  }

  close() {
    this.manualClose = true;
    this.socket?.close();
    this.socket = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Bequemer Listener: `net.on('table_state', msg => …)`. */
  on(type, handler) {
    this.addEventListener(type, (event) => handler(event.detail));
  }
}

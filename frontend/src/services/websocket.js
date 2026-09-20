/**
 * WebSocket service for ThreatForecast real-time streaming (/ws/live)
 */
import { wsUrl } from '../api/api';

class LiveWebSocketService {
  constructor() {
    this.ws = null;
    this.listeners = {
      packet: new Set(),
      forecast: new Set(),
      status: new Set(),
    };
    this.state = 'disconnected';
    this.reconnectTimer = null;
    this.disconnectTimer = null;
    this.isStopped = false;
    this.refCount = 0;
  }

  connect() {
    this.refCount++;
    
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isStopped = false;
    this.updateState('connecting');

    try {
      const url = wsUrl();
      console.log('[WS] CONNECTING TO:', url);
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('[WS] OPEN:', url);
        this.updateState('connected');
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data?.event_type === 'packet') {
            this.emit('packet', data);
          } else if (data?.event_type === 'forecast' || Array.isArray(data?.risk_scores)) {
            this.emit('forecast', data);
          }
        } catch {
          // Ignore non-JSON or malformed frames
        }
      };

      this.ws.onerror = (event) => {
        console.error('[WS] ERROR:', event);
        console.error('[WS] URL:', url);
        this.updateState('error');
      };

      this.ws.onclose = (event) => {
        console.error(
          '[WS] CLOSE:',
          'code=', event.code,
          'reason=', event.reason,
          'wasClean=', event.wasClean
        );
        this.updateState('disconnected');
        this.ws = null;
        if (!this.isStopped) {
          this.reconnectTimer = setTimeout(() => {
            this.connect();
          }, 2500);
        }
      };
    } catch {
      this.updateState('error');
    }
  }

  disconnect() {
    this.refCount = Math.max(0, this.refCount - 1);
    
    if (this.refCount > 0) {
      return;
    }

    this.disconnectTimer = setTimeout(() => {
      this.isStopped = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.updateState('disconnected');
    }, 100);
  }

  updateState(newState) {
    this.state = newState;
    this.emit('status', newState);
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].add(callback);
      if (event === 'status') {
        callback(this.state);
      }
    }
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].delete(callback);
    }
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => {
        try {
          cb(data);
        } catch {
          // Do not fail if a subscriber errors
        }
      });
    }
  }
}

export const liveWsService = new LiveWebSocketService();
export default liveWsService;

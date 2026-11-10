import WebSocketClient from '@gamestdio/websocket';

import type {
  ApiStreamingMessageJSON,
  ApiStreamingWireEventJSON,
} from '@tstodon/api';
import type { AppDispatch, GetState } from 'mastodon/store';

import { getAccessToken } from './initial_state';

let sharedConnection: WebSocketClient | undefined;

/**
 * An event as received, its payload still encoded: an entity is a JSON string
 * (the streaming contract of `@tstodon/api`, `packages/api/src/streaming.ts`).
 * The WebSocket message adds `stream`; an SSE frame has none.
 */
export type StreamEvent = ApiStreamingWireEventJSON;

/** A stream's params (`tag`, `list`), sent with its name. */
export type StreamParams = Record<string, string>;

export interface StreamCallbacks {
  onConnect: () => void;
  onReceive: (event: StreamEvent) => void;
  onDisconnect: () => void;
}

interface Subscription extends StreamCallbacks {
  channelName: string;
  params: StreamParams;
}

interface ConnectionCallbacks<Received> {
  connected: () => void;
  received: (event: Received) => void;
  disconnected: () => void;
  reconnected: () => void;
}

const subscriptions: Subscription[] = [];

const subscriptionCounters: Record<string, number> = {};

const addSubscription = (subscription: Subscription) => {
  subscriptions.push(subscription);
};

const removeSubscription = (subscription: Subscription) => {
  const index = subscriptions.indexOf(subscription);

  if (index !== -1) {
    subscriptions.splice(index, 1);
  }
};

const subscribe = ({ channelName, params, onConnect }: Subscription) => {
  const key = channelNameWithInlineParams(channelName, params);
  const count = subscriptionCounters[key] ?? 0;

  if (count === 0) {
    sharedConnection?.send(JSON.stringify({ type: 'subscribe', stream: channelName, ...params }));
  }

  subscriptionCounters[key] = count + 1;
  onConnect();
};

const unsubscribe = ({ channelName, params, onDisconnect }: Subscription) => {
  const key = channelNameWithInlineParams(channelName, params);
  const count = subscriptionCounters[key] || 1;

  if (count === 1 && sharedConnection?.readyState === WebSocketClient.OPEN) {
    sharedConnection.send(JSON.stringify({ type: 'unsubscribe', stream: channelName, ...params }));
  }

  subscriptionCounters[key] = count - 1;
  onDisconnect();
};

const sharedCallbacks: ConnectionCallbacks<ApiStreamingMessageJSON> = {
  connected() {
    subscriptions.forEach(subscription => subscribe(subscription));
  },

  received(data) {
    const { stream } = data;

    subscriptions.filter(({ channelName, params }) => {
      const streamChannelName = stream[0];

      if (stream.length === 1) {
        return channelName === streamChannelName;
      }

      const streamIdentifier = stream[1];

      if (['hashtag', 'hashtag:local'].includes(channelName)) {
        return channelName === streamChannelName && params.tag === streamIdentifier;
      } else if (channelName === 'list') {
        return channelName === streamChannelName && params.list === streamIdentifier;
      }

      return false;
    }).forEach(subscription => {
      subscription.onReceive(data);
    });
  },

  disconnected() {
    subscriptions.forEach(subscription => unsubscribe(subscription));
  },

  reconnected() {
  },
};

const channelNameWithInlineParams = (channelName: string, params: StreamParams) => {
  const entries = Object.entries(params);

  if (entries.length === 0) {
    return channelName;
  }

  return `${channelName}&${entries.map(([key, value]) => `${key}=${value}`).join('&')}`;
};

export const connectStream = (
  channelName: string,
  params: StreamParams,
  callbacks: (dispatch: AppDispatch, getState: GetState) => StreamCallbacks,
) => (dispatch: AppDispatch, getState: GetState) => {
  const streamingAPIBaseURL: unknown = getState().meta.get('streaming_api_base_url');
  const accessToken = getAccessToken();
  const { onConnect, onReceive, onDisconnect } = callbacks(dispatch, getState);

  if(!accessToken) throw new Error("Trying to connect to the streaming server but no access token is available.");
  if (typeof streamingAPIBaseURL !== 'string') throw new Error('Trying to connect to the streaming server but its URL is not known.');

  // If we cannot use a websockets connection, we must fall back
  // to using individual connections for each channel
  if (!streamingAPIBaseURL.startsWith('ws')) {
    const connection = createEventSourceConnection(streamingAPIBaseURL, accessToken, channelNameWithInlineParams(channelName, params), {
      connected() {
        onConnect();
      },

      received(data) {
        onReceive(data);
      },

      disconnected() {
        onDisconnect();
      },

      reconnected() {
        onConnect();
      },
    });

    return () => {
      connection.close();
    };
  }

  const subscription: Subscription = {
    channelName,
    params,
    onConnect,
    onReceive,
    onDisconnect,
  };

  addSubscription(subscription);

  // If a connection is open, we can execute the subscription right now. Otherwise,
  // because we have already registered it, it will be executed on connect

  if (!sharedConnection) {
    sharedConnection = createWebSocketConnection(streamingAPIBaseURL, accessToken, sharedCallbacks);
  } else if (sharedConnection.readyState === WebSocketClient.OPEN) {
    subscribe(subscription);
  }

  return () => {
    removeSubscription(subscription);
    unsubscribe(subscription);
  };
};

const KNOWN_EVENT_TYPES = [
  'update',
  'delete',
  'notification',
  'conversation',
  'filters_changed',
  'announcement',
  'announcement.delete',
  'announcement.reaction',
];

/** An SSE frame (its event name and `data` line) as the event it carries. */
const eventSourceEvent = (type: string, data: string): StreamEvent | undefined => {
  switch (type) {
  case 'update':
  case 'status.update':
  case 'delete':
  case 'notification':
  case 'conversation':
  case 'announcement':
  case 'announcement.reaction':
  case 'announcement.delete':
    return { event: type, payload: data };
  case 'notifications_merged':
    return { event: type, payload: '1' };
  case 'filters_changed':
    return { event: type };
  default:
    return undefined;
  }
};

const handleEventSourceMessage = (e: Event, received: (event: StreamEvent) => void) => {
  const event = e instanceof MessageEvent && typeof e.data === 'string' ? eventSourceEvent(e.type, e.data) : undefined;

  if (event) {
    received(event);
  }
};

/** A WebSocket message: the event with the stream it belongs to (`@tstodon/api`'s contract). */
const parseMessage = (data: string): ApiStreamingMessageJSON => JSON.parse(data);

const createWebSocketConnection = (streamingAPIBaseURL: string, accessToken: string, { connected, received, disconnected, reconnected }: ConnectionCallbacks<ApiStreamingMessageJSON>) => {
  // The access token goes as the WebSocket protocol, as upstream sends it.
  const ws = new WebSocketClient(`${streamingAPIBaseURL}/api/v1/streaming/?`, [accessToken]);

  ws.onopen = connected;
  ws.onmessage = (e: MessageEvent<string>) => received(parseMessage(e.data));
  ws.onclose = disconnected;
  ws.onreconnect = reconnected;

  return ws;
};

const createEventSourceConnection = (streamingAPIBaseURL: string, accessToken: string, channelNameWithParams: string, { connected, received, disconnected }: ConnectionCallbacks<StreamEvent>) => {
  const params = channelNameWithParams.split('&');
  let channelName = params.shift() ?? '';

  channelName = channelName.replace(/:/g, '/');

  // `public:local:media` is `/public/local?only_media=true` (upstream tested
  // for `:media` after the colons had become slashes, so it never matched).
  if (channelName.endsWith('/media')) {
    channelName = channelName.replace('/media', '');
    params.push('only_media=true');
  }

  params.push(`access_token=${accessToken}`);

  const es = new EventSource(`${streamingAPIBaseURL}/api/v1/streaming/${channelName}?${params.join('&')}`);

  es.onopen = () => {
    connected();
  };

  KNOWN_EVENT_TYPES.forEach(type => {
    es.addEventListener(type, e => handleEventSourceMessage(e, received));
  });

  es.onerror = () => disconnected();

  return es;
};

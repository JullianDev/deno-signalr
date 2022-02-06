import { Hub } from "./Hub.ts";
import { Evt, to, WS } from "../../deps.ts"
import { ClientOptions, Connection, ConnectionState, ErrorCode, HubMessageData, Message, StandardError } from "../typings.ts";
export { to };
/**
 * A SignalR client for Deno which supports ASP.net
 * @extends {Evt<[ "connected", undefined ] | [ "disconnected", string ] | [ "reconnecting", number ] | [ "error", StandardError ]>}
 */
 export class Client extends Evt<
 [ "connected", undefined ] |
 [ "disconnected", string ] |
 [ "reconnecting", number ] |
 [ "error", StandardError ]>
 {
 /**
  * The URL to connect to
  * @public
  */
 public url?: string;
 /**
  * The queries to add to the URL
  * @public
  */
 public query: Record<string, string> = {};
 /**
  * The headers for all requests
  * @public
  */
 public headers: Record<string,  string> = {};
 /**
  * The delay time for reconnecting in milliseconds
  * @public
  */
 public reconnectDelayTime = 5000;
 /**
  * The timeout for calls in milliseconds
  * @public
  */
 public callTimeout = 5000;
 /**
  * The call timeout
  * @public
  */
 public connection?: Connection;
 /**
  * Whether or not it's bound
  * @public
  */
 public _bound = false;
 /**
  * The websocket connection
  * @public
  */
 public _websocket?: WS | WebSocket;
 /**
  * The hub names to connect to
  * @public
  */
 public _hubNames?: string[] | Record<string, unknown>[];
 /**
  * The inovcation ID
  * @public
  */
 public _invocationId = 0;
 /**
  * Call timeout in milliseconds
  * @public
  */
 public _callTimeout = 0;
 /**
  * The timeout to keep alive in milliseconds
  * @public
  */
 public _keepAliveTimeout = 5000;
 /**
  * Whether or not to keep the connection alive after disconnection
  * @public
  */
 public _keepAlive = true;
 /**
  * Interval to beat in milliseconds
  * @public
  */
 public _beatInterval = 5000;
 /**
  * setInterval instance to beat
  * @public
 */
 public _beatTimer?: number;
 /**
  * Amount of times to attempt reconnect
  * @public
  * @type {number}
  */
 public _reconnectCount = 0;
 /**
  * setTimeout instance for reconnection
  * @public
  */
 public _reconnectTimer?: number;
 /**
  * @constructor
  * @param url - URL to connect to
  * @param hubs - Hubs to connect to
  * @param options - Client options
  */
 constructor(url: string, hubs: string[], options?: ClientOptions) {
   super();
   this.url = url;
   this.connection = {
       state: ConnectionState.disconnected,
       hub: new Hub(this),
       lastMessageAt: new Date().getTime()
   };
   this._hubNames = hubs;
   if (options) {
     if (options.query) this.query = options.query;
     if (options.headers) this.headers = options.headers;
     if (options.callTimeout) this.callTimeout = options.callTimeout;
     if (options.reconnectDelayTime) this.reconnectDelayTime = options.reconnectDelayTime;
   }
}
/**
* Proccess a message
* @public
* @param message - The SignalR hub message
*/
public _receiveMessage(message: MessageEvent): void {
 this._markLastMessage();
 if (message.type === "message" && message.data !== "{}") {
     const data: HubMessageData = JSON.parse(message.data);
     if (data.M) {
         data.M.forEach((message: Message) => {
             if (this.connection && message.H) {
                 const hub = message.H;
                 const handler = this.connection.hub.handlers[hub];
                 if (handler && message.M) {
                     // @ts-ignore: Handlers should always be records unless modified code
                     const method = handler[message.M];
                     if (method) method.apply(this, message.A);
                 }
             }
         }) 
     } else if (data.I) {
         if (this.connection) this.connection.hub._handleCallback(data.I, data.E, data.R)
     }
 }
}
/**
* Send a message to a hub
* @public
* @param hub - The message hub to send a message to 
* @param method = THe method to send with the data
* @param args - Args to send
*/
public _sendMessage(hub: string, method: string, args: unknown): void {
   const payload = JSON.stringify({
      H: hub,
      M: method,
      A: args,
      I: this._invocationId 
   });
   this._invocationId++;
   if (this._websocket && (this._websocket.readyState === WebSocket.OPEN)) 
     this._websocket.send(payload);
}
/**
* Negotiate with the endpoint for a connection token
* @public
* @param {number} [protocol=1.5]
* @returns {Promise<Record<string, unknown>>}
*/
public _negotiate(protocol = 1.5): Promise<Record<string, unknown>> {
   const query = new URLSearchParams({
       ...this.query,
       connectionData: JSON.stringify(this._hubNames),
       clientProtocol: String(protocol)
   });
   const headers = new Headers(this.headers);

   const url = new URL(`${this.url}/negotiate`);
   url.search = query.toString();
   return new Promise((resolve, reject) => {
     fetch(url, {
         method: "GET",
         headers: headers
     }).catch((error: Error) =>
         reject({ code: ErrorCode.negotiateError, message: error })
     ).then(async (data: Response | void) => {
         if (data) {
             if (data.ok) {
                 const negotiateProtocol = await data.json();
                 if (!negotiateProtocol.TryWebSockets) reject({ code: ErrorCode.unsupportedWebsocket, message: null });
                 resolve(negotiateProtocol);
             } else if (data.status === 302 || data.status === 401 || data.status === 403) {
                 reject({ code: ErrorCode.unauthorized, message: null });
             } else {
                 reject({ code: ErrorCode.negotiateError, message: data.status })
             }
         }
     });
   });
}
/**
* Connect to the websocket
* @public
* @param protocol - The SignalR client protocol
*/
public _connect(protocol = 1.5): void {
   if (this.url && this.connection) {
       const url = new URL(`${this.url.replace(/^http/, "ws")}/connect`);
       const query = new URLSearchParams({
           ...this.query,
           connectionData: JSON.stringify(this._hubNames),
           clientProtocol: String(protocol),
           transport: "webSockets",
           connectionToken: String(this.connection.token),
           tid: "10"
       });
       url.search = query.toString();

       let webSocket: WS | WebSocket;
       // @ts-ignore: Ignore this line, in browser context it will be defined. In Deno, it will not be defined by default.
       if (document === undefined) {
           webSocket = new WS(url.toString(), this.headers)
       } else {
           webSocket = new WebSocket(url.toString());
       }
       webSocket.onopen = () => {
           this._invocationId = 0;
           this._callTimeout = 0;
           this._start().then(() => {
               this._reconnectCount = 0;
               this.post(["connected", undefined]);
               if (this.connection) this.connection.state = ConnectionState.connected;
               this._markLastMessage();
               if (this._keepAlive) this._beat();
           }).catch((error: StandardError) => {
             if (this.connection) this.connection.state = ConnectionState.disconnected;
             this._error(error.code, error.message);
           });
       }
       webSocket.onerror = (event: Event | ErrorEvent) => {
           if ("error" in event) this._error(ErrorCode.socketError, event.error);
       }
       webSocket.onmessage = (message: MessageEvent<unknown>) => {
           this._receiveMessage(message);
       }
       webSocket.onclose = () => {
         this._callTimeout = 1000;
         if (this.connection) this.connection.state = ConnectionState.disconnected;
         this.post(["disconnected", "failed"]);
         this._reconnect();
       }
       this._websocket = webSocket;
   }
}
/**
* Attempt a reconnection to the websocket
* @public
* @param restart - Whether or not it should restart
*/
public _reconnect(restart = false): void {
   if (this._reconnectTimer || (this.connection && this.connection.state === ConnectionState.reconnecting)) return;
   this._clearBeatTimer();
   this._close();
   this._reconnectTimer = setTimeout(() => {
     this._reconnectCount++
     if (this.connection) this.connection.state = ConnectionState.reconnecting;
     this.post(["reconnecting", this._reconnectCount]);
     restart ? this.start() : this._connect();
     this._reconnectTimer = undefined;
   }, this.reconnectDelayTime || 5000);
}
/**
* Clear the current reconnect timer if it exists
* @public
*/
public _clearReconnectTimer(): void {
 if (this._reconnectTimer) {
     clearTimeout(this._reconnectTimer);
     this._reconnectTimer = undefined;
 }
}
/**
* Watch time elapsed since last message
* @public
*/
public _beat(): void {
   if (this.connection) {
     const timeElapsed = new Date().getTime() - this.connection.lastMessageAt;
     if (timeElapsed > this._keepAliveTimeout) {
         this.connection.state = ConnectionState.disconnected;
         this._error(ErrorCode.connectLost)
     } else {
         this._beatTimer = setTimeout(() => {
             this._beat()
         }, this._beatInterval);
     }
 }
}
/**
* Clear the beat timer
* @public
*/
public _clearBeatTimer(): void {
 if (this._beatTimer) {
   clearTimeout(this._beatTimer);
   this._beatTimer = undefined;
 }
}
/**
* Mark the last message time as current time
* @public
*/
public _markLastMessage(): void {
 if (this.connection) this.connection.lastMessageAt = new Date().getTime();
}
/**
* Start the SignalR connection
* @public
* @param protocol - The SignalR client protocol
*/
public _start(protocol = 1.5): Promise<unknown> {
   if (this.url && this.connection) {
       const query = new URLSearchParams({
           ...this.query,
           connectionData: JSON.stringify(this._hubNames),
           clientProtocol: String(protocol),
           transport: "webSockets",
           connectionToken: String(this.connection.token)
       });
       const headers = new Headers(this.headers);
       const url = new URL(`${this.url}/start`);
       url.search = query.toString();

       return new Promise((resolve, reject) => {
         fetch(url, {
             method: "GET",
             headers: headers
         }).catch((error: Error) =>
             reject({ code: ErrorCode.startError, message: error })
         ).then(async (data: Response | void) => {
             if (data) {
                 if (data.ok) {
                     resolve(await data.json())
                 } else if (data.status === 302 || data.status === 401 || data.status === 403) {
                     reject({ code: ErrorCode.unauthorized, message: null });
                 } else {
                     reject({ code: ErrorCode.startError, message: data.status })
                 }
             }
         });
       });
   } else throw new Error("A connection has not yet been established.");
}
/**
* Abort the SignalR connection
* @public
* @param protocol - The SignalR client protocol
*/
public _abort(protocol = 1.5): Promise<void> {
 if (this.url && this.connection) {
     const query = new URLSearchParams({
         ...this.query,
         connectionData: JSON.stringify(this._hubNames),
         clientProtocol: String(protocol),
         transport: "webSockets",
         connectionToken: String(this.connection.token)
     });
     const headers = new Headers(this.headers);
     const url = new URL(`${this.url}/abort`);
     url.search = query.toString();
     
     return new Promise((resolve, reject) => {
       fetch(url, {
           method: "POST",
           headers: headers
       }).catch((error: Error) =>
           reject({ code: ErrorCode.abortError, message: error })
       ).then((data: Response | void) => {
           if (data) {
               if (data.ok) {
                   resolve()
               } else if (data.status === 302 || data.status === 401 || data.status === 403) {
                   reject({ code: ErrorCode.unauthorized, message: null });
               } else {
                   reject({ code: ErrorCode.abortError, message: data.status })
               }
           }
       });
     });
 } else throw new Error(`A connection has not yet been established.`);
}
/**
* Emit an error and attempt a reconnect
* @public
* @param {SignalRErrorCode} code - SignalRError code to emit
* @param {unknown?} extra = Extra data to emit
*/
public _error(code: ErrorCode, extra?: unknown): void {
   this.post(["error", { 
       code: code, 
       message: extra 
   }]);
   if (code === ErrorCode.negotiateError || code === ErrorCode.connectError) {
       this._reconnect(true);
   } else if (code === ErrorCode.startError || code === ErrorCode.connectLost) {
       this._reconnect();
   }
}
/**
* Close the SignalR instance
* @public
*/
public _close(): void {
   if (this._websocket) {
     this._websocket.onclose = () => {};
     this._websocket.onmessage = () => {};
     this._websocket.onerror = () => {};
     this._websocket.close();
     this._websocket = undefined;
   }
}
/**
* Start the SignalR connection
* @public
* @param protocol - The client protocol
*/
public start(protocol = 1.5): void {
   if (!this._bound) {
       if (!this.url) return this._error(ErrorCode.invalidURL);
       if (!(this.url.startsWith('http:') || this.url.startsWith('https:'))) return this._error(ErrorCode.invalidProtocol);
       if (this._hubNames && this._hubNames.length) {
           const hubs = [];
           for (const hub of this._hubNames) hubs.push({ name: hub });
           this._hubNames = hubs;
       } else return this._error(ErrorCode.noHub);
       this._bound = true;
   }
   this._negotiate(protocol).then((negotiateProtocol: Record<string, unknown>) => {
       if (this.connection && typeof(negotiateProtocol.ConnectionToken) === "string" && typeof(negotiateProtocol.ConnectionId) === "string") {
         this.connection.token = negotiateProtocol.ConnectionToken;
         this.connection.id = negotiateProtocol.ConnectionId;
       }
       if (negotiateProtocol.KeepAliveTimeout && typeof(negotiateProtocol.KeepAliveTimeout) === "number") {
         this._keepAlive = true
         this._keepAliveTimeout = negotiateProtocol.KeepAliveTimeout * 1000
         this._beatInterval = this._keepAliveTimeout / 4
       } else {
         this._keepAlive = false
       }
       this._connect(protocol);
   }).catch((error: Error) => {
       if (this.connection) this.connection.state = ConnectionState.disconnected;
       // @ts-ignore: Promise only rejects as a Record<string, unknown>, but the type is an Error
       this._error(error.code, error.message);
   });
}
/**
* End the SignalR connection
* @public
*/
public end() {
   if (this._websocket) {
       this.post(["disconnected", "end"]);
       this._abort().catch();
       this._clearReconnectTimer();
       this._clearBeatTimer();
       this._close();
   }
}
}
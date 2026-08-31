// @ts-check
/**
 * The debugger's own thread.
 *
 * The whole file is nine lines because the phase is not about workers. The
 * adapter is `Session`, which knows nothing about threads; this is the shim
 * that gives it a mailbox. Swapping the shim for a socket is what "a real VS
 * Code debug adapter" would mean, and nothing above this line would change.
 *
 * Why it matters that the interpreter is over here: `continue` on a program
 * that never ends holds *this* thread for as long as it runs, and the page
 * stays live enough to send the `pause` that stops it.
 */
import { Session } from './protocol.js';

/**
 * A worker's global scope is a port: it posts to the page and receives from
 * it. Typed as one rather than as a `DedicatedWorkerGlobalScope`, because the
 * checker is configured for the DOM and the two libraries cannot both be on —
 * and a port is all this file uses of it anyway.
 * @type {import('./client.js').Port}
 */
const scope = /** @type {any} */ (self);

const session = new Session((message) => scope.postMessage(message));

scope.onmessage = async (event) => {
  scope.postMessage(await session.handle(event.data));
};

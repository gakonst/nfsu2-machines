// The Worker's entry (wrangler.jsonc main): its fetch (worker.js: the HTTP routes and the /lan upgrade) and the Switch
// Durable Object class (switch/do.js).
export { default } from './worker.js';
export { Switch } from './switch/do.js';

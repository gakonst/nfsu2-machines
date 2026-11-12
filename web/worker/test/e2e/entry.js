// The Worker for the HTTP differential test (http.diff.mjs): src/worker.js's fetch, with the Switch stand-in in place
// of the switch (src/switch/do.js is the switch's own; the HTTP routes need only its internal routes).
export { default } from '../../src/worker.js';
export { Switch } from './switch-standin.js';

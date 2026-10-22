import './compat.mjs';
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
import './time-warp.mjs';

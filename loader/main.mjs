#!/usr/bin/env node
// Thin alias of the entry point. The real entry is loader/launch.mjs (the macOS launcher runs boot.mjs, which imports it).
import { main } from './launch.mjs';

process.exitCode = await main(process.argv.slice(2));

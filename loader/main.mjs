#!/usr/bin/env node
// Thin alias of the entry point. The real entry is loader/launch.mjs (launch.vbs runs it directly).
import { main } from './launch.mjs';

process.exitCode = await main(process.argv.slice(2));

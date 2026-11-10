import { basename } from 'node:path';

// The command that the user types to run this package. The global install has the alias "djinni".
// Without the global install, the user runs "npx djinni-mcp". The npm package "djinni" belongs to another maintainer,
// so a hint never says "npx djinni".
export function binName(script: string | undefined = process.argv[1]): string {
  return script !== undefined && basename(script) === 'djinni' ? 'djinni' : 'npx djinni-mcp';
}

// The bin of this process, for the hints and the usage lines.
export const BIN = binName();

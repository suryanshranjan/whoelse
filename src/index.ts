import { runHook, type Agent } from './hooks.js';
import { init } from './commands/init.js';
import { check, status } from './commands/status.js';
import { doctor } from './commands/doctor.js';
import { VERSION } from './version.js';

const USAGE = `whoelse ${VERSION}

Parallel coding agents merge cleanly and still break each other.
whoelse tells an agent when another one renames, removes or changes
something it uses.

Usage:
  whoelse init [--project]   install hooks (Claude Code, Codex, Antigravity)
  whoelse status [--json]    every worktree, what it changed, every clash
  whoelse check [branch...]  same as a gate: exit 1 on a hard clash (CI)
  whoelse doctor             is everything wired up?
  whoelse hook <agent>       hook entry point (reads JSON on stdin)
`;

const AGENTS = new Set<Agent>(['claude-code', 'codex', 'antigravity']);

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const cwd = process.cwd();
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    case '-v':
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'hook':
      if (AGENTS.has(rest[0] as Agent)) await runHook(rest[0] as Agent, rest[1]);
      else process.stdout.write('{}');
      return 0; // never fail the agent's session
    case 'init':
      return init(cwd, rest);
    case 'status':
      return status(cwd, rest);
    case 'check':
      return check(cwd, rest);
    case 'doctor':
      return doctor(cwd);
    default:
      process.stderr.write(`whoelse: unknown command '${command}'\n\n${USAGE}`);
      return 1;
  }
}

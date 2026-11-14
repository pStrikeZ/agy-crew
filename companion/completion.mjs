// Shell tab completion: `completion <bash|zsh|fish|powershell>` prints a script that asks
// `__complete <words...>` for candidates. Everything is decided here, in one
// place, so the shells never drift apart; the scripts only pass the
// words typed so far and print what comes back.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PRODUCT, globalHome } from './identity.mjs';
import { loadWorktreeJobs } from './worktrees.mjs';

const TASK_FLAGS = ['--model', '--effort', '--timeout', '--account', '--restricted', '--unrestricted', '--json', '--prompt', '--prompt-file', '--stdin'];
const MODES = ['staffer', 'research', 'review', 'implement', 'ask'];

/** What each command takes: positional kind(s) and flags. */
const COMMANDS = {
  staffer: { flags: TASK_FLAGS }, research: { flags: TASK_FLAGS }, review: { flags: TASK_FLAGS },
  implement: { flags: TASK_FLAGS }, ask: { flags: TASK_FLAGS },
  continue: { flags: [...TASK_FLAGS, '--job', '--conversation'] },
  restart: { args: ['job'], flags: ['--account', '--timeout', '--json'] },
  observe: { args: ['job'], flags: ['--json'] },
  inspect: { args: ['job'], flags: ['--plain', '--no-follow', '--no-color', '--no-mouse', '--here'] },
  status: { args: ['job'], flags: ['--json'] },
  wait: { args: ['job'], flags: ['--timeout', '--json'] },
  result: { args: ['job'], flags: ['--json'] },
  cancel: { args: ['job'], flags: [] },
  setup: { flags: ['--apply', '--restrict'] },
  install: { flags: ['--hosts', '--all', '--dry-run', '--status', '--json', '--no-completion'] },
  uninstall: { flags: ['--hosts', '--all', '--dry-run', '--json'] },
  start: { args: ['account'], flags: ['--model', '--help'], dashdash: true },
  omp: { args: ['account'], flags: ['--use-at-my-own-risk', '--family', '--help'], dashdash: true },
  completion: { args: ['shell'], flags: [] },
  version: { flags: [] }, help: { flags: [] },
};

const ACCOUNTS = {
  list: { flags: ['--json'] },
  login: { args: ['account'], flags: [] },
  import: { args: ['name'], flags: ['--home'] },
  remove: { args: ['account'], flags: ['--yes'] },
  rename: { args: ['account'], flags: [] },
  'refresh-email': { args: ['account*'], flags: ['--json'] },
  enable: { args: ['account'], flags: [] },
  disable: { args: ['account'], flags: [] },
  parallel: { args: ['account', 'n'], flags: [] },
  quota: { args: ['account*'], flags: ['--refresh', '--json'] },
  cooldown: { sub: { clear: { args: ['account'], flags: ['--family'] }, record: { args: ['account'], flags: ['--family', '--retry-at'] } } },
  hold: { sub: { acquire: { args: ['account'], flags: ['--pid', '--family', '--json'] }, release: { args: [], flags: ['--json'] } } },
};

export const MODELS = [
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
  'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
  'gemini-3.5-flash-high', 'gemini-3.5-flash-medium', 'gemini-3.5-flash-low',
  'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
  'flash', 'pro',
];
const FAMILIES = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-pro',
  'claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-oss-120b'];
const SHELLS = ['bash', 'zsh', 'fish', 'powershell'];

/** Values of a flag: a list, or null when only files make sense (the shell
 *  falls back to them when nothing comes back). */
function flagValues(flag, ctx) {
  switch (flag) {
    case '--model': return MODELS;
    case '--effort': return ['low', 'medium', 'high'];
    case '--account': return ['auto', ...ctx.accounts()];
    case '--family': return FAMILIES;
    case '--hosts': return ctx.hosts();
    case '--restrict': return ['none', 'review', 'research', 'implement', 'staffer'];
    case '--job': return ctx.jobs();
    default: return null;
  }
}

const argValues = (kind, ctx) => ({ job: ctx.jobs, account: ctx.accounts, shell: () => SHELLS }[kind]?.() ?? []);
const starts = (list, prefix) => [...new Set(list)].filter((c) => c.startsWith(prefix));

/** Candidates for the last word of `words` (the argv after the command name).
 *  Pure given ctx = { accounts(), jobs(), hosts() }; returns a string[]. */
export function complete(words, ctx) {
  const cur = words.at(-1) ?? '';
  const prior = words.slice(0, -1);
  const cmd = prior[0];
  if (prior.length === 0) return starts([...Object.keys(COMMANDS), 'accounts', 'help'], cur);

  // After `--` (start) the words belong to agy: nothing to offer.
  if (cmd === 'start' && prior.includes('--')) return [];

  let spec = cmd === 'accounts' ? undefined : COMMANDS[cmd];
  let rest = prior.slice(1);
  if (cmd === 'accounts') {
    const subs = Object.keys(ACCOUNTS);
    if (rest.length === 0) return starts(subs, cur);
    spec = ACCOUNTS[rest[0]];
    rest = rest.slice(1);
    if (spec?.sub) {
      if (rest.length === 0) return starts(Object.keys(spec.sub), cur);
      spec = spec.sub[rest[0]];
      rest = rest.slice(1);
    }
  }
  if (!spec) return [];

  // A flag that takes a value, typed last: complete the value.
  const valueFlags = new Set(['--model', '--effort', '--timeout', '--account', '--prompt', '--prompt-file', '--hosts', '--restrict',
    '--job', '--conversation', '--family', '--home', '--pid', '--retry-at']);
  const last = prior.at(-1);
  if (last && valueFlags.has(last) && last !== '--') {
    const values = flagValues(last, ctx);
    if (last === '--hosts') {   // comma list: complete the segment after the last comma
      const done = cur.includes(',') ? cur.slice(0, cur.lastIndexOf(',') + 1) : '';
      return starts(values, cur.slice(done.length)).map((v) => done + v);
    }
    return values ? starts(values, cur) : [];
  }

  if (cur.startsWith('-')) {
    const flags = [...(spec.flags || []), ...(spec.dashdash ? ['--'] : [])];
    const used = new Set(prior.filter((w) => w.startsWith('--')));
    return starts(flags, cur).filter((f) => f === '--' || !used.has(f));
  }

  // Positionals: count those already given (flag values are not positionals).
  let given = 0;
  for (let i = 0; i < rest.length; i++) {
    if (valueFlags.has(rest[i])) i++;
    else if (!rest[i].startsWith('-')) given++;
  }
  const args = spec.args || [];
  const kind = args[given] ?? (args.at(-1)?.endsWith('*') ? args.at(-1) : null);
  if (!kind) return [];
  const taken = kind.endsWith('*') ? new Set(rest) : new Set();   // a repeatable list offers each value once
  return starts(argValues(kind.replace('*', ''), ctx), cur).filter((v) => !taken.has(v));
}

// ---------------------------------------------------------------------------
// live data
// ---------------------------------------------------------------------------

/** Never throws: completion that errors out spoils the user's prompt. */
const safe = (fn) => { try { return fn() || []; } catch { return []; } };

function liveContext() {
  return {
    accounts: () => safe(() => JSON.parse(fs.readFileSync(path.join(globalHome(), 'pool.json'), 'utf8')).accounts.map((a) => a.name)),
    jobs: () => safe(() => {
      const top = spawnTop();
      return loadWorktreeJobs({ current: top }).map((j) => j.id).reverse();
    }),
    hosts: () => ['claude', 'codex', 'omp', 'opencode', 'dsh', 'shared'],
  };
}

function spawnTop() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? path.normalize(r.stdout.trim()) : process.cwd();
}

/** PowerShell hands the words over as JSON in the environment: Windows
 *  PowerShell drops empty-string arguments to native commands and mangles
 *  embedded quotes, and the empty last word is what says "a new word starts". */
function envWords() {
  const raw = process.env.AGY_CREW_COMPLETE_WORDS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [];
  }
}

/** `__complete <words...>`: one candidate per line. */
export function cmdComplete(argvWords) {
  const words = envWords() ?? argvWords;
  const lines = complete(words.length ? words : [''], liveContext());
  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// shell scripts
// ---------------------------------------------------------------------------

const SCRIPTS = {
  bash: `# bash completion for ${PRODUCT}; add to ~/.bashrc:  source <(${PRODUCT} completion bash)
_${PRODUCT.replaceAll('-', '_')}() {
  local IFS=$'\\n' words out
  # The words typed so far, split on whitespace only (not on = or :).
  IFS=$' \\t\\n' read -ra words <<< "\${COMP_LINE:0:COMP_POINT}"
  [[ "\${COMP_LINE:0:COMP_POINT}" == *[[:space:]] ]] && words+=("")
  out=$(${PRODUCT} __complete "\${words[@]:1}" 2>/dev/null)
  if [ -n "$out" ]; then
    COMPREPLY=($out)
  else
    COMPREPLY=($(compgen -f -- "\${COMP_WORDS[COMP_CWORD]}"))
  fi
}
complete -o filenames -F _${PRODUCT.replaceAll('-', '_')} ${PRODUCT}
`,
  zsh: `#compdef ${PRODUCT}
# zsh completion for ${PRODUCT}; add to ~/.zshrc (after compinit):  source <(${PRODUCT} completion zsh)
_${PRODUCT.replaceAll('-', '_')}() {
  local -a out
  out=("\${(@f)$(${PRODUCT} __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  out=("\${(@)out:#}")
  if (( \${#out} )); then
    compadd -Q -- "\${out[@]}"
  else
    _files
  fi
}
if (( ! $+functions[compdef] )); then autoload -Uz compinit && compinit; fi
compdef _${PRODUCT.replaceAll('-', '_')} ${PRODUCT}
`,
  fish: `# fish completion for ${PRODUCT}; install puts it in ~/.config/fish/completions/${PRODUCT}.fish
function __${PRODUCT.replaceAll('-', '_')}_complete
    set -l words (commandline -opc)[2..-1] (commandline -ct)
    ${PRODUCT} __complete $words 2>/dev/null
end
complete -c ${PRODUCT} -f -a '(__${PRODUCT.replaceAll('-', '_')}_complete)'
`,
  powershell: `# PowerShell completion for ${PRODUCT}; add to $PROFILE:  ${PRODUCT} completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName '${PRODUCT}', '${PRODUCT}.cmd', '${PRODUCT}.ps1' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  # Words fully before the cursor, then the word being typed (empty after a space).
  $words = @(
    $commandAst.CommandElements | Select-Object -Skip 1 |
      Where-Object { $_.Extent.EndOffset -lt $cursorPosition } |
      ForEach-Object {
        if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value } else { $_.Extent.Text }
      }
  ) + @([string]$wordToComplete)
  $previous = $env:AGY_CREW_COMPLETE_WORDS
  try {
    $env:AGY_CREW_COMPLETE_WORDS = ConvertTo-Json -InputObject $words -Compress
    $out = @(& ${PRODUCT} __complete 2>$null)
  } catch {
    $out = @()
  } finally {
    $env:AGY_CREW_COMPLETE_WORDS = $previous
  }
  $out | Where-Object { $_ } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`,
};

export const SHELL_NAMES = SHELLS;
export const completionScript = (shell) => SCRIPTS[shell === 'pwsh' ? 'powershell' : shell] ?? null;

export function cmdCompletion(opts) {
  const shell = opts._[0];
  const script = completionScript(shell);
  if (!script) {
    process.stderr.write(`usage: ${PRODUCT} completion <${SHELLS.join('|')}>\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(script);
}

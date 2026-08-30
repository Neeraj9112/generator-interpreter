// @ts-check
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { globals } from './builtins.js';
import { compile, CompileError } from './compile.js';
import { collectNow } from './gc.js';
import { EvalError, run as runTree } from './evaluate.js';
import { LexError, lineCol } from './lexer.js';
import { ParseError, parse } from './parser.js';
import { SemanticError } from './validate.js';
import { execute, load, VmError } from './vm.js';

/** @typedef {import('./parser.js').Program} Program */
/** @typedef {import('./vm.js').Frame} Frame */
/** @typedef {import('./values.js').Value} Value */

const USAGE = `usage: node src/cli.js [options] file.pip

  --tree     run on the tree-walking evaluator instead of the bytecode VM
  --stats    print heap and collector figures to stderr when the program ends
  -h, --help show this
`;

/**
 * Exit codes, because a CLI that always exits 0 cannot be used from a script.
 * The split between the two failures is the one a caller acts on differently:
 * `USER` means fix the invocation, `SOURCE` means fix the program, and a
 * program that ran and then failed is still a program that ran.
 */
const OK = 0;
const RUNTIME = 1;
const SOURCE = 2;
const USER = 3;

/**
 * @typedef {{file: string, tree: boolean, stats: boolean}} Options
 */

/**
 * @param {string[]} args
 * @returns {Options|{help: true}|{error: string}}
 */
export function parseArgs(args) {
  let tree = false;
  let stats = false;
  /** @type {string|null} */
  let file = null;

  for (const arg of args) {
    if (arg === '-h' || arg === '--help') return { help: true };
    else if (arg === '--tree') tree = true;
    else if (arg === '--stats') stats = true;
    else if (arg.startsWith('-')) return { error: `unknown option '${arg}'` };
    else if (file !== null) return { error: 'expected exactly one file' };
    else file = arg;
  }

  if (file === null) return { error: 'expected a file to run' };
  return { file, tree, stats };
}

/**
 * Where in the source something went wrong, whichever kind of failure it was.
 *
 * The four error types carry position in three different shapes, because each
 * one is raised by a pass that knows a different amount: the lexer has an
 * index and no tree, the tree-walker has the node it was evaluating, and the
 * compiler and VM have a span. None of them should have to care that a
 * terminal wants a line number, so the conversion happens here.
 * @param {unknown} error
 * @returns {number|null}
 */
function indexOf(error) {
  if (error instanceof LexError || error instanceof ParseError) return error.index;
  if (error instanceof SemanticError || error instanceof CompileError || error instanceof VmError) return error.span.start;
  if (error instanceof EvalError) return error.node.span.start;
  return null;
}

/**
 * The offending line with a caret under it, the way a compiler shows one.
 * Worth the dozen lines: a message with a line number in it makes you count,
 * and a caret does not.
 * @param {string} source
 * @param {number} index
 * @returns {string}
 */
function excerpt(source, index) {
  const { line, col } = lineCol(source, index);
  const text = source.split('\n')[line - 1] ?? '';
  const gutter = `${line} | `;
  // Tabs are one column to `lineCol` and eight to a terminal, so the padding
  // copies whatever whitespace the line actually starts with.
  const pad = text.slice(0, col - 1).replace(/[^\t]/g, ' ');
  return `${gutter}${text}\n${' '.repeat(gutter.length)}${pad}^`;
}

/**
 * A VM failure knows the frames it happened in, so the CLI can print a stack
 * trace. The tree-walker cannot: its stack is the JS one plus a chain of
 * suspended generators, and by the time the error has propagated out there is
 * nothing left to read. Same asymmetry the debugger's stack pane has.
 * @param {string} source
 * @param {Frame[]} frames
 * @returns {string[]}
 */
function trace(source, frames) {
  return frames
    .slice(1)
    .reverse()
    .map((frame) => `    in ${frame.name} (line ${lineCol(source, frame.callSpan.start).line})`);
}

/**
 * @param {string} source
 * @param {string} file
 * @param {unknown} error
 * @returns {number} the exit code the failure deserves
 */
function report(source, file, error) {
  if (!(error instanceof Error)) throw error;
  const index = indexOf(error);
  let where = file;
  if (index !== null) {
    const { line, col } = lineCol(source, index);
    where = `${file}:${line}:${col}`;
  }
  // The lexer and the parser bake their position into the message, because
  // they are also thrown at callers who have no file to put in front of it.
  // Here there is one, so the same numbers twice on one line is just noise.
  const message = error.message.replace(/ \(line \d+, col \d+\)$/, '');
  stderr.write(`${where}: ${error.name}: ${message}\n`);
  if (index !== null) stderr.write(`${excerpt(source, index)}\n`);
  if (error instanceof VmError) for (const line of trace(source, error.frames)) stderr.write(`${line}\n`);

  // A program that would not have run at all is a different kind of wrong
  // from one that ran and then hit something.
  const beforeRunning = error instanceof LexError || error instanceof ParseError
    || error instanceof SemanticError || error instanceof CompileError;
  return beforeRunning ? SOURCE : RUNTIME;
}

/**
 * Run on the VM, keeping the machine so `--stats` has something to report.
 * `vm.run` would do the same work and throw the machine away, and the point
 * of the flag is the numbers the machine is holding at the end.
 * @param {Program} program
 * @param {boolean} stats
 * @returns {Value}
 */
function onVm(program, stats) {
  const machine = load(compile(program), globals().child());
  const iter = execute(machine);
  let step = iter.next();
  while (!step.done) step = iter.next();

  if (stats) {
    // One last collection before reporting, so "live" is what survives rather
    // than whatever happened to be lying around when the program stopped.
    collectNow(machine);
    const { heap } = machine;
    stderr.write(`heap: ${heap.liveCount} live, ${heap.size} slots, ${heap.collections} collections\n`);
  }

  const result = step.value;
  if (result.ok) return result.value;
  throw new VmError(result.message, result.span, result.frames);
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  const options = parseArgs(args);
  if ('help' in options) {
    stdout.write(USAGE);
    return OK;
  }
  if ('error' in options) {
    stderr.write(`${options.error}\n\n${USAGE}`);
    return USER;
  }

  /** @type {string} */
  let source;
  try {
    source = await readFile(options.file, 'utf8');
  } catch {
    stderr.write(`cannot read ${options.file}\n`);
    return USER;
  }

  try {
    const program = parse(source);
    if (options.tree) {
      if (options.stats) stderr.write('heap: the tree-walker has none; it keeps JS values and lets JS collect them\n');
      runTree(program, globals().child());
    } else {
      onVm(program, options.stats);
    }
    return OK;
  } catch (error) {
    return report(source, options.file, error);
  }
}

// Only when run as a program. Importing this module to test `parseArgs` should
// not run somebody's file or take the process down with it.
if (argv[1] !== undefined && resolve(argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  exit(await main(argv.slice(2)));
}

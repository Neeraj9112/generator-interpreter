import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { run as runTree, EvalError } from '../src/evaluate.js';
import { compile } from '../src/compile.js';
import { SemanticError } from '../src/validate.js';
import { run as runVm, VmError } from '../src/vm.js';
import { globals } from '../src/builtins.js';
import { describe } from '../src/values.js';
import { PROGRAMS } from './programs.js';

/** @typedef {import('./programs.js').Case} Case */
/** @typedef {{result: string, output: string[]}|{error: string, output: string[]}} Outcome */

/**
 * Both backends mount a program the same way — in a child of the builtins,
 * with `print` pointed at a list — so the only thing that differs between
 * these two functions is which one executes.
 * @param {string} source
 * @returns {Outcome}
 */
function onTreeWalker(source) {
  /** @type {string[]} */
  const output = [];
  const env = globals({ write: (line) => output.push(line) }).child();
  try {
    return { result: describe(runTree(parse(source), env)), output };
  } catch (error) {
    if (error instanceof EvalError || error instanceof SemanticError) return { error: error.message, output };
    throw error;
  }
}

/**
 * @param {string} source
 * @returns {Outcome}
 */
function onVm(source) {
  /** @type {string[]} */
  const output = [];
  const env = globals({ write: (line) => output.push(line) }).child();
  try {
    return { result: describe(runVm(compile(parse(source)), env)), output };
  } catch (error) {
    if (error instanceof VmError || error instanceof SemanticError) return { error: error.message, output };
    throw error;
  }
}

/**
 * @param {Case} program
 * @returns {Outcome}
 */
function expected(program) {
  const output = program.output ?? [];
  return program.error === undefined ? { result: program.result ?? 'nothing', output } : { error: program.error, output };
}

for (const program of PROGRAMS) {
  test(program.name, () => {
    const tree = onTreeWalker(program.source);
    const vm = onVm(program.source);
    // The differential half: whatever the language means, both backends have
    // to mean the same thing by it, including the wording of a failure.
    assert.deepEqual(vm, tree, 'the two backends disagree');
    assert.deepEqual(tree, expected(program));
  });
}

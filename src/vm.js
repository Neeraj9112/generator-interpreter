// @ts-check
import { Env } from './env.js';
import { BINARY_OP, OP } from './compile.js';
import { applyBinary, applyUnary, arityMessage, arityOf, describe, isCallable, isTruthy } from './values.js';

/** @typedef {import('./parser.js').Span} Span */
/** @typedef {import('./compile.js').Chunk} Chunk */
/** @typedef {import('./values.js').Value} Value */
/** @typedef {import('./values.js').Closure} Closure */

/**
 * One call in progress. `pc` is where this frame resumes, `env` is its scope
 * chain, and `base` is how far the operand stack unwinds when it returns.
 *
 * The whole point of this record is that it is *data*. The tree-walker keeps
 * the same information in the JS call stack and a chain of suspended
 * generators, where nothing can read it, nothing can bound it, and nothing
 * can put it back. Here it is an array you can inspect, cap, and — once
 * Phase 6 arrives — rewind.
 * @typedef {{chunk: Chunk, pc: number, env: Env, base: number, name: string, callSpan: Span}} Frame
 */

/**
 * The pause point, yielded *before* each instruction runs, so a debugger
 * showing this step is showing what is about to happen. `frames` and `stack`
 * are the live arrays rather than copies — same bargain the tree-walker
 * makes with `env`, and for the same reason: a snapshot per instruction
 * would cost more than the program does.
 * @typedef {{pc: number, op: number, chunk: Chunk, span: Span, env: Env, frames: Frame[], stack: Value[]}} VmStep
 */

/**
 * @typedef {{ok: true, value: Value}} VmSuccess
 * @typedef {{ok: false, message: string, span: Span, frames: Frame[]}} VmFailure
 * @typedef {VmSuccess|VmFailure} VmResult
 */

/**
 * Recursion is bounded by an array length now rather than by the host's call
 * stack, so the limit is ours to pick and ours to report. Deep enough that
 * no honest program reaches it; shallow enough that runaway recursion says
 * so instead of exhausting memory.
 */
export const MAX_FRAMES = 20000;

export class VmError extends Error {
  /**
   * @param {string} message
   * @param {Span} span
   * @param {Frame[]} frames
   */
  constructor(message, span, frames) {
    super(message);
    this.name = 'VmError';
    this.span = span;
    this.frames = frames;
  }
}

/**
 * @param {string} message
 * @param {Span} span
 * @param {Frame[]} frames
 * @returns {VmFailure}
 */
function fail(message, span, frames) {
  // Snapshot: the caller reads this after the loop has stopped touching the
  // live array, and a stack trace of a moment has to be of that moment.
  return { ok: false, message, span, frames: frames.map((frame) => ({ ...frame })) };
}

/**
 * Run `chunk` as a generator, yielding once per instruction.
 *
 * There is no recursion in here at all: a call pushes a frame and the same
 * loop keeps going, which is why a Pip program can recurse thousands deep
 * without the JS stack noticing. That flatness is also what makes the loop
 * suspendable at *any* point — every bit of state a resume needs is in
 * `frames` and `stack`, not in the shape of the loop.
 * @param {Chunk} chunk
 * @param {Env} env
 * @returns {Generator<VmStep, VmResult, void>}
 */
export function* execute(chunk, env) {
  /** @type {Value[]} */
  const stack = [];
  /** @type {Frame[]} */
  const frames = [{ chunk, pc: 0, env, base: 0, name: chunk.name, callSpan: chunk.spans[0] }];

  for (;;) {
    const frame = frames[frames.length - 1];
    const { code, constants } = frame.chunk;
    const pc = frame.pc;
    const op = code[pc];
    const span = frame.chunk.spans[pc];

    yield { pc, op, chunk: frame.chunk, span, env: frame.env, frames, stack };

    switch (op) {
      case OP.CONST:
        stack.push(constants[code[pc + 1]]);
        frame.pc += 2;
        break;

      case OP.POP:
        stack.pop();
        frame.pc += 1;
        break;

      case OP.GET: {
        const name = String(constants[code[pc + 1]]);
        const owner = frame.env.resolve(name);
        if (owner === null) return fail(`undefined variable '${name}'`, span, frames);
        stack.push(owner.vars.get(name));
        frame.pc += 2;
        break;
      }

      case OP.SET: {
        const name = String(constants[code[pc + 1]]);
        if (!frame.env.assign(name, stack[stack.length - 1])) {
          return fail(`assignment to undeclared variable '${name}'`, span, frames);
        }
        frame.pc += 2;
        break;
      }

      case OP.DEFINE:
        // Assignment and declaration both leave their value on the stack —
        // `let x = 1` is a statement whose value is 1, same as the tree-walker.
        frame.env.define(String(constants[code[pc + 1]]), stack[stack.length - 1]);
        frame.pc += 2;
        break;

      case OP.CLOSURE: {
        const proto = frame.chunk.protos[code[pc + 1]];
        /** @type {Closure} */
        const closure = { type: 'closure', name: proto.name, proto, env: frame.env };
        // Bound in the same env it captured, so a function can call itself.
        frame.env.define(proto.name, closure);
        stack.push(closure);
        frame.pc += 2;
        break;
      }

      case OP.PUSH_SCOPE:
        frame.env = frame.env.child();
        frame.pc += 1;
        break;

      case OP.POP_SCOPE:
        // Non-null by construction: the compiler emits these in pairs.
        frame.env = /** @type {Env} */ (frame.env.parent);
        frame.pc += 1;
        break;

      case OP.JUMP:
        frame.pc += 2 + code[pc + 1];
        break;

      case OP.JUMP_IF_FALSE:
        frame.pc += 2 + (isTruthy(stack.pop()) ? 0 : code[pc + 1]);
        break;

      case OP.JUMP_IF_FALSE_KEEP:
      case OP.JUMP_IF_TRUE_KEEP: {
        // `&&` and `||` keep the operand that decided the answer and discard
        // the one that didn't, which is why these peek before they pop.
        const jumpWhen = op === OP.JUMP_IF_TRUE_KEEP;
        if (isTruthy(stack[stack.length - 1]) === jumpWhen) {
          frame.pc += 2 + code[pc + 1];
        } else {
          stack.pop();
          frame.pc += 2;
        }
        break;
      }

      case OP.CALL: {
        const argc = code[pc + 1];
        const base = stack.length - argc - 1;
        const callee = stack[base];
        if (!isCallable(callee)) return fail(`${describe(callee)} is not a function`, span, frames);
        if (argc !== arityOf(callee)) return fail(arityMessage(callee, argc), span, frames);

        // Advanced before the frame is pushed, so RET lands after the call.
        frame.pc += 2;

        if (callee.type === 'native') {
          const args = stack.slice(base + 1);
          stack.length = base;
          stack.push(callee.call(args));
          break;
        }
        if (callee.type !== 'closure') {
          return fail(`${callee.name} was built by the tree-walker and has no compiled body`, span, frames);
        }
        if (frames.length >= MAX_FRAMES) {
          return fail(`too much recursion, over ${MAX_FRAMES} calls deep`, span, frames);
        }

        // The call's scope hangs off the env the function was *defined* in,
        // never off the caller's. One line, and it is the whole of lexical
        // scope — the compiler had no part in it.
        const callEnv = callee.env.child();
        for (let i = 0; i < argc; i++) callEnv.define(callee.proto.params[i], stack[base + 1 + i]);
        stack.length = base;
        frames.push({ chunk: callee.proto, pc: 0, env: callEnv, base, name: callee.name, callSpan: span });
        break;
      }

      case OP.RET: {
        const value = stack.pop();
        const done = /** @type {Frame} */ (frames.pop());
        stack.length = done.base;
        stack.push(value);
        break;
      }

      case OP.NEG:
      case OP.NOT: {
        const result = applyUnary(op === OP.NEG ? '-' : '!', stack.pop());
        if (!result.ok) return fail(result.message, span, frames);
        stack.push(result.value);
        frame.pc += 1;
        break;
      }

      case OP.HALT:
        return { ok: true, value: stack.pop() };

      default: {
        const operator = BINARY_OP[op];
        if (operator === undefined) return fail(`vm: unknown opcode ${op}`, span, frames);
        const right = stack.pop();
        const left = stack.pop();
        const result = applyBinary(operator, left, right);
        if (!result.ok) return fail(result.message, span, frames);
        stack.push(result.value);
        frame.pc += 1;
        break;
      }
    }
  }
}

/**
 * Drain the iterator for non-debug use. Same boundary the tree-walker's
 * `run` draws: inside, a failure is a value the loop returns; outside, it is
 * a JS exception, because a caller who isn't stepping has nowhere to put it.
 * @param {Chunk} chunk
 * @param {Env} [env]
 * @returns {Value}
 */
export function run(chunk, env = new Env()) {
  const iter = execute(chunk, env);
  /** @type {IteratorResult<VmStep, VmResult>} */
  let step = iter.next();
  while (!step.done) step = iter.next();
  const result = step.value;
  if (result.ok) return result.value;
  throw new VmError(result.message, result.span, result.frames);
}

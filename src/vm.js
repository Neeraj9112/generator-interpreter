// @ts-check
import { Env } from './env.js';
import { BINARY_OP, OP } from './compile.js';
import { collectNow } from './gc.js';
import { Heap } from './heap.js';
import { NO_JOURNAL } from './journal.js';
import { applyBinary, applyUnary, arityMessage, arityOf, describe, isCallable, isTruthy } from './values.js';

/** @typedef {import('./parser.js').Span} Span */
/** @typedef {import('./compile.js').Chunk} Chunk */
/** @typedef {import('./values.js').Value} Value */
/** @typedef {import('./values.js').Closure} Closure */
/** @typedef {import('./journal.js').Journal} Journal */
/** @typedef {import('./heap.js').Handle} Handle */

/**
 * One call in progress. `pc` is where this frame resumes, `env` is its scope
 * chain, and `base` is how far the operand stack unwinds when it returns.
 *
 * The whole point of this record is that it is *data*. The tree-walker keeps
 * the same information in the JS call stack and a chain of suspended
 * generators, where nothing can read it, nothing can bound it, and nothing
 * can put it back. Here it is an array you can inspect, cap and rewind.
 *
 * `env` is a handle rather than a scope, so a frame's link to its scope is an
 * address in the heap like every other edge between two objects. A collector
 * can follow that; a JS reference it would have to be told about.
 * @typedef {{chunk: Chunk, pc: number, env: Handle, base: number, name: string, callSpan: Span}} Frame
 */

/**
 * The whole of the VM's state, and deliberately nothing but data: two arrays,
 * a heap and a journal. The generator below keeps nothing of its own across a
 * yield, so the machine is separable from the generator walking it — hand
 * the same machine to a fresh generator and execution carries on from
 * exactly where the last one was suspended.
 *
 * That is what step-back is built on. A generator cannot be rewound; one of
 * these can be put back to what it was and walked again.
 *
 * The stack and the scopes hold *words*: a number, a boolean, nothing, or a
 * handle into the heap. Everything too big for a slot lives in the heap and
 * is reached by address, which is what makes the object graph something the
 * machine owns rather than something JS owns on its behalf.
 * @typedef {{stack: Value[], frames: Frame[], journal: Journal, heap: Heap}} Machine
 */

/**
 * The pause point, yielded *before* each instruction runs, so a debugger
 * showing this step is showing what is about to happen. `frames` and `stack`
 * are the live arrays rather than copies — same bargain the tree-walker
 * makes with `env`, and for the same reason: a snapshot per instruction
 * would cost more than the program does.
 *
 * `env` arrives dereferenced, because every observer of a pause wants the
 * scope and not its address. The values *inside* it are still words: an
 * inspector showing them has the heap right here to read them with.
 * @typedef {{pc: number, op: number, chunk: Chunk, span: Span, env: Env, frames: Frame[], stack: Value[], heap: Heap}} VmStep
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
 * A machine holding `chunk`, ready to run in `env` and not yet started.
 *
 * The journal is a parameter rather than something the machine makes for
 * itself: recording history costs memory on every instruction, and only a
 * caller that means to walk backwards through it should be paying.
 * @param {Chunk} chunk
 * @param {Env} env
 * @param {Journal} [journal]
 * @returns {Machine}
 */
export function load(chunk, env, journal = NO_JOURNAL) {
  const heap = new Heap(journal);
  // The machine takes the chain over rather than borrowing it: `print` and
  // every other binding already in it move into cells, so from here on there
  // is no value the VM can reach that isn't in its own heap.
  const root = heap.intern(env);
  return {
    stack: [],
    frames: [{ chunk, pc: 0, env: root, base: 0, name: chunk.name, callSpan: chunk.spans[0] }],
    journal,
    heap,
  };
}

/**
 * Run a machine as a generator, yielding once per instruction.
 *
 * There is no recursion in here at all: a call pushes a frame and the same
 * loop keeps going, which is why a Pip program can recurse thousands deep
 * without the JS stack noticing. That flatness is also what makes the loop
 * suspendable at *any* point — every bit of state a resume needs is in the
 * machine, not in the shape of the loop.
 *
 * Every write to that state goes through `journal`, which either keeps what
 * it overwrote or throws it away, depending on whether anyone means to undo
 * it later. The loop cannot tell the difference and has no business knowing.
 * @param {Machine} machine
 * @returns {Generator<VmStep, VmResult, void>}
 */
export function* execute(machine) {
  const { stack, frames, journal, heap } = machine;

  for (;;) {
    // The only place a collection is safe. Between instructions, every value
    // the program can still reach is on the stack, in a scope, or in the
    // journal; *inside* one, a value can exist solely in a JS local that
    // nothing can trace, and sweeping it there is a corruption that shows up
    // later, somewhere else, and only sometimes.
    if (heap.due) collectNow(machine);

    const frame = frames[frames.length - 1];
    const { code, constants } = frame.chunk;
    const pc = frame.pc;
    const op = code[pc];
    const span = frame.chunk.spans[pc];
    const env = heap.envOf(frame.env);

    yield { pc, op, chunk: frame.chunk, span, env, frames, stack, heap };

    journal.mark(frame);

    switch (op) {
      case OP.CONST:
        // Through the pool rather than straight out of `constants`, so a
        // literal inside a loop is one cell the code owns and not one a turn.
        journal.push(stack, heap.constant(frame.chunk, code[pc + 1]));
        frame.pc += 2;
        break;

      case OP.POP:
        journal.pop(stack);
        frame.pc += 1;
        break;

      case OP.GET: {
        const name = String(constants[code[pc + 1]]);
        const owner = env.resolve(name);
        if (owner === null) return fail(`undefined variable '${name}'`, span, frames);
        journal.push(stack, owner.vars.get(name));
        frame.pc += 2;
        break;
      }

      case OP.SET: {
        // Resolved here rather than left to `Env.assign`, because the write
        // has to be journalled against the scope that actually owns the name.
        const name = String(constants[code[pc + 1]]);
        const owner = env.resolve(name);
        if (owner === null) return fail(`assignment to undeclared variable '${name}'`, span, frames);
        journal.bind(owner, name, stack[stack.length - 1]);
        frame.pc += 2;
        break;
      }

      case OP.DEFINE:
        // Assignment and declaration both leave their value on the stack —
        // `let x = 1` is a statement whose value is 1, same as the tree-walker.
        journal.bind(env, String(constants[code[pc + 1]]), stack[stack.length - 1]);
        frame.pc += 2;
        break;

      case OP.CLOSURE: {
        const proto = frame.chunk.protos[code[pc + 1]];
        /** @type {Closure} */
        const closure = { type: 'closure', name: proto.name, proto, env: frame.env };
        // A cell of its own, holding the address of the scope it captured.
        // That edge is what makes the heap a graph rather than a list, and it
        // is the one that can close a cycle: the scope binds the closure back.
        const handle = heap.write(closure);
        // Bound in the same env it captured, so a function can call itself.
        journal.bind(env, proto.name, handle);
        journal.push(stack, handle);
        frame.pc += 2;
        break;
      }

      case OP.PUSH_SCOPE:
        journal.scope(frame, heap.childEnv(frame.env));
        frame.pc += 1;
        break;

      case OP.POP_SCOPE:
        // Non-null by construction: the compiler emits these in pairs.
        journal.scope(frame, /** @type {Handle} */ (heap.parentOf(frame.env)));
        frame.pc += 1;
        break;

      case OP.JUMP:
        frame.pc += 2 + code[pc + 1];
        break;

      case OP.JUMP_IF_FALSE:
        frame.pc += 2 + (isTruthy(heap.read(journal.pop(stack))) ? 0 : code[pc + 1]);
        break;

      case OP.JUMP_IF_FALSE_KEEP:
      case OP.JUMP_IF_TRUE_KEEP: {
        // `&&` and `||` keep the operand that decided the answer and discard
        // the one that didn't, which is why these peek before they pop.
        const jumpWhen = op === OP.JUMP_IF_TRUE_KEEP;
        if (isTruthy(heap.read(stack[stack.length - 1])) === jumpWhen) {
          frame.pc += 2 + code[pc + 1];
        } else {
          journal.pop(stack);
          frame.pc += 2;
        }
        break;
      }

      case OP.CALL: {
        const argc = code[pc + 1];
        const base = stack.length - argc - 1;
        const callee = heap.read(stack[base]);
        if (!isCallable(callee)) return fail(`${describe(callee)} is not a function`, span, frames);
        if (argc !== arityOf(callee)) return fail(arityMessage(callee, argc), span, frames);

        // Advanced before the frame is pushed, so RET lands after the call.
        frame.pc += 2;

        if (callee.type === 'native') {
          // Whatever a native does beyond the stack is outside the journal's
          // reach: `print` writes to a sink the VM has never heard of. Putting
          // that back is the sink owner's problem, which is the argument for
          // an append-only one — undoing it is then a truncation.
          // A builtin is plain JS and knows nothing about the heap, so its
          // arguments are read on the way in and its answer written on the
          // way out. That boundary is the whole of what a builtin has to be
          // told about any of this.
          const args = stack.slice(base + 1).map((word) => heap.read(word));
          journal.truncate(stack, base);
          journal.push(stack, heap.write(callee.call(args)));
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
        //
        // Its bindings go in unjournalled: this instruction created the scope,
        // and undoing the frame push puts it beyond reach again, so there is
        // nobody left to notice them not being put back.
        const callEnv = heap.childEnv(callee.env);
        const scope = heap.envOf(callEnv);
        for (let i = 0; i < argc; i++) scope.define(callee.proto.params[i], stack[base + 1 + i]);
        journal.truncate(stack, base);
        journal.pushFrame(frames, { chunk: callee.proto, pc: 0, env: callEnv, base, name: callee.name, callSpan: span });
        break;
      }

      case OP.RET: {
        const value = journal.pop(stack);
        const done = journal.popFrame(frames);
        journal.truncate(stack, done.base);
        journal.push(stack, value);
        break;
      }

      case OP.NEG:
      case OP.NOT: {
        const result = applyUnary(op === OP.NEG ? '-' : '!', heap.read(journal.pop(stack)));
        if (!result.ok) return fail(result.message, span, frames);
        journal.push(stack, heap.write(result.value));
        frame.pc += 1;
        break;
      }

      case OP.HALT:
        return { ok: true, value: heap.read(journal.pop(stack)) };

      default: {
        const operator = BINARY_OP[op];
        if (operator === undefined) return fail(`vm: unknown opcode ${op}`, span, frames);
        // Read both operands, hand them to the shared semantics, write the
        // answer back. `values.js` never learns the heap exists, which is why
        // an operator still means exactly what it meant on the tree-walker.
        const right = heap.read(journal.pop(stack));
        const left = heap.read(journal.pop(stack));
        const result = applyBinary(operator, left, right);
        if (!result.ok) return fail(result.message, span, frames);
        journal.push(stack, heap.write(result.value));
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
  const iter = execute(load(chunk, env));
  /** @type {IteratorResult<VmStep, VmResult>} */
  let step = iter.next();
  while (!step.done) step = iter.next();
  const result = step.value;
  if (result.ok) return result.value;
  throw new VmError(result.message, result.span, result.frames);
}

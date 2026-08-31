// @ts-check
import { BLACK, GREY } from '../src/gc.js';
import { DebugClient } from './client.js';

/** @typedef {import('../src/parser.js').Span} Span */
/** @typedef {import('./client.js').Snapshot} Snapshot */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function el(id) {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found;
}

const ui = {
  source: el('source'),
  editor: /** @type {HTMLTextAreaElement} */ (el('editor')),
  scopes: el('scopes'),
  stack: el('stack'),
  output: el('output'),
  status: el('status'),
  failure: el('failure'),
  edit: el('edit'),
  showEmpty: /** @type {HTMLInputElement} */ (el('show-empty')),
  ribbon: /** @type {HTMLCanvasElement} */ (el('ribbon')),
  ribbonCount: el('ribbon-count'),
  backend: el('backend'),
  codePane: el('code-pane'),
  codeTitle: el('code-title'),
  code: el('code'),
  heapPane: el('heap-pane'),
  heapCount: el('heap-count'),
  heap: el('heap'),
  main: /** @type {HTMLElement} */ (document.querySelector('main')),
};

/** Pixels per step in the ribbon: it stretches between these to fill the strip. */
const MIN_COLUMN = 2;
const MAX_COLUMN = 10;

/** @type {Record<string, HTMLButtonElement>} */
const buttons = {
  back: /** @type {HTMLButtonElement} */ (el('back')),
  step: /** @type {HTMLButtonElement} */ (el('step')),
  stepLine: /** @type {HTMLButtonElement} */ (el('step-line')),
  stepOver: /** @type {HTMLButtonElement} */ (el('step-over')),
  run: /** @type {HTMLButtonElement} */ (el('run')),
  reset: /** @type {HTMLButtonElement} */ (el('reset')),
  gcStep: /** @type {HTMLButtonElement} */ (el('gc-step')),
  gcFinish: /** @type {HTMLButtonElement} */ (el('gc-finish')),
};

/**
 * The debugger, on its own thread.
 *
 * Everything below this line asks it questions and draws the answers. Nothing
 * below this line can reach an `Env`, a `Heap` or a suspended generator, and
 * that is not a restriction the page works around — it is the phase. A pane
 * that used to read the interpreter's memory now sends `scopes` and waits.
 */
const client = new DebugClient(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));

/** The last answer, and what every render function draws from. @type {Snapshot|null} */
let snap = null;
/** The source the adapter was launched with. The page keeps its own copy; asking for text it already has would be silly. */
let source = '';
/** @type {string[]} */
let lines = [];
/** @type {number[]} */
let lineStarts = [0];
let editing = false;
/** A program that would not load at all: bad syntax, or a misplaced `break`. @type {{label: string, message: string}|null} */
let loadError = null;
let backendName = 'tree';
/**
 * Where the ribbon's columns are, so a click on one can be turned back into
 * the step it draws. Set by the last paint, because that is the only thing
 * that knows how wide a column ended up and how far into the trace the
 * visible window starts.
 * @type {{start: number, column: number, count: number, dropped: number}|null}
 */
let ribbonView = null;
/**
 * Which refresh is the current one.
 *
 * Answers arrive out of order once asking is asynchronous — a `stopped` event
 * and a click can both start one, and the slower is not always the older.
 * Only the newest is allowed to paint.
 */
let generation = 0;

/**
 * Index of every line start, so a source index becomes a line number by
 * binary search rather than by counting newlines from the top.
 * @param {string} text
 * @returns {number[]}
 */
function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * @param {number} index
 * @returns {number}
 */
function lineOf(index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Ask for the whole picture again and draw it.
 *
 * One call, several requests, and a render only if nothing newer has been
 * asked for since. The synchronous version of this function was called
 * `render`.
 * @returns {Promise<void>}
 */
async function refresh() {
  const mine = ++generation;
  const next = await client.refresh({ traceCount: ribbonCapacity() });
  if (mine !== generation) return;
  snap = next;
  render();
}

/** The most columns the ribbon could draw, which is all the trace worth asking for. @returns {number} */
function ribbonCapacity() {
  return Math.max(1, Math.floor(ui.ribbon.clientWidth / MIN_COLUMN));
}

/**
 * Rebuild the debugger around new source, carrying breakpoints and the
 * chosen backend across so editing a line doesn't silently drop either.
 * @param {string} text
 * @returns {Promise<boolean>} whether the source loaded
 */
async function load(text) {
  const breakpoints = snap === null ? [] : snap.state.breakpoints;
  source = text;
  lines = text.split('\n');
  lineStarts = lineStartsOf(text);
  try {
    await client.launch(text, { backend: backendName, breakpoints });
    loadError = null;
  } catch (err) {
    // The adapter labelled this: a SemanticError is not a parse error, and
    // calling it one sends you hunting for a typo in a line that is spelled
    // correctly.
    const error = /** @type {Error} */ (err);
    loadError = { label: error.name, message: error.message };
  }
  await refresh();
  return loadError === null;
}

/**
 * 1-based line and column of a source index, for error reporting.
 * @param {number} index
 * @returns {string}
 */
function where(index) {
  const line = lineOf(index);
  return `line ${line}, col ${index - lineStarts[line - 1] + 1}`;
}

/**
 * Paint one source line, marking whatever part of `span` falls inside it. A
 * span crossing several lines lights up on each of them, which is what makes
 * a whole block visibly "the current node" when it exits.
 * @param {HTMLElement} code
 * @param {string} text
 * @param {number} lineStart
 * @param {Span|null} span
 */
function paintLine(code, text, lineStart, span) {
  if (span === null) {
    code.textContent = text;
    return;
  }
  const from = Math.max(span.start - lineStart, 0);
  const to = Math.min(span.end - lineStart, text.length);
  if (from >= to) {
    code.textContent = text;
    return;
  }
  const mark = document.createElement('mark');
  mark.textContent = text.slice(from, to);
  code.append(text.slice(0, from), mark, text.slice(to));
}

function renderSource() {
  ui.source.replaceChildren();
  if (snap === null || !snap.state.loaded) return;
  const span = snap.state.span;
  const currentLine = snap.state.line;
  const breakpoints = new Set(snap.state.breakpoints);

  lines.forEach((text, index) => {
    const line = index + 1;
    const row = document.createElement('div');
    row.className = line === currentLine ? 'row current' : 'row';

    const gutter = document.createElement('button');
    gutter.className = breakpoints.has(line) ? 'gutter breakpoint' : 'gutter';
    gutter.dataset.line = String(line);
    gutter.textContent = String(line);

    const code = document.createElement('div');
    code.className = 'code';
    paintLine(code, text, lineStarts[index], span);

    row.append(gutter, code);
    ui.source.append(row);
    if (line === currentLine) row.scrollIntoView({ block: 'nearest' });
  });
}

/**
 * The yield stream, drawn as a silhouette of nesting depth over time. Every
 * step is one column: it rises with each `enter` and falls with each `exit`,
 * so a subtree is an arch and a loop is a row of identical teeth. This is the
 * one view that shows what the project is — execution as a sequence of pause
 * points you can walk — rather than one instant of it.
 *
 * Canvas rather than elements because a run is thousands of columns wide and
 * each is a few pixels; there is nothing here worth a DOM node.
 */
function renderRibbon() {
  const canvas = ui.ribbon;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;

  const density = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * density);
  canvas.height = Math.round(height * density);
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  ctx.setTransform(density, 0, 0, density, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const style = getComputedStyle(document.documentElement);
  const ink = (/** @type {string} */ name) => style.getPropertyValue(name).trim();
  const base = height - 1;

  ctx.fillStyle = ink('--rule');
  ctx.fillRect(0, base, width, 1);

  const marks = snap === null ? [] : snap.trace.marks;
  if (snap === null || marks.length === 0) {
    ui.ribbonCount.textContent = '';
    ribbonView = null;
    return;
  }

  // The adapter was asked for as many marks as the strip can hold, so the
  // window is already the right one and only the column width is left to
  // decide. Columns widen to fill the strip while a run is short, so a fresh
  // program reads as a skyline rather than a smudge in the corner.
  const column = Math.min(MAX_COLUMN, width / marks.length);
  ribbonView = { start: snap.trace.start, column, count: marks.length, dropped: snap.trace.dropped };
  const deepest = Math.max(...marks.map((mark) => mark.depth), 1);
  const usable = height - 8;
  const breakpoints = new Set(snap.state.breakpoints);

  // Columns butt up against each other rather than leaving a gap, so the tops
  // join into one continuous edge and the shape reads as a silhouette.
  const span = column + 0.5;

  marks.forEach((mark, index) => {
    const x = index * column;
    const y = base - Math.round((mark.depth / deepest) * usable);

    ctx.fillStyle = ink('--sel');
    ctx.fillRect(x, y, span, base - y);

    ctx.fillStyle = mark.phase === 'enter' ? ink('--enter') : ink('--exit');
    ctx.fillRect(x, y, span, 2);

    if (breakpoints.has(mark.line)) {
      ctx.fillStyle = ink('--stop');
      ctx.fillRect(x, base - 2, span, 2);
    }
  });

  // The cursor sits on the last column, which is where execution is paused.
  const cursor = (marks.length - 1) * column;
  ctx.fillStyle = ink('--fg');
  ctx.fillRect(cursor, 0, 1, height);

  const state = snap.state;
  const dropped = snap.trace.dropped > 0 ? `, ${snap.trace.dropped} dropped` : '';
  // What stepping back will cost from here, which is the one thing about it
  // a user cannot see for themselves: the VM undoes a bounded journal, and
  // everything past its edge — and the whole of the tree-walker — is a
  // replay of the program from the top.
  const back = state.rewindsBy === 'journal' ? `, ${state.reach} undoable` : ', step back replays';
  const steps = state.stepCount === 1 ? '1 step' : `${state.stepCount} steps`;
  ui.ribbonCount.textContent = `${steps}, depth ${state.depth}${dropped}${back}`;
}

function renderScopes() {
  ui.scopes.replaceChildren();
  if (snap === null || snap.scopes.length === 0) {
    ui.scopes.append(note('nothing running'));
    return;
  }
  // A call pushes two scopes, one for the parameters and one for the body
  // block, and a closure chain stacks several of them. The empty ones are
  // real, but three blank boxes above the scope you came to read is a poor
  // first impression, so they are off by default rather than gone.
  const scopes = snap.scopes.filter((scope) => ui.showEmpty.checked || scope.variables.length > 0);
  for (const scope of scopes) {
    const block = document.createElement('div');
    block.className = 'scope';

    const label = document.createElement('div');
    label.className = 'scope-label';
    label.textContent = scope.name;
    block.append(label);

    if (scope.variables.length === 0) {
      block.append(note('empty'));
    } else {
      for (const variable of scope.variables) {
        const row = document.createElement('div');
        row.className = 'binding';
        row.append(span('name', variable.name), span('value', variable.value));
        block.append(row);
      }
    }
    ui.scopes.append(block);
  }
}

/**
 * The heap as a grid of slots, one square each.
 *
 * Colour says two different things depending on whether a collection is
 * running. Idle, a square is its kind — string, function, scope — and the
 * ones held only by the journal are called out, because "you can still step
 * back to this" is the reason most of them are still here. Mid-collection,
 * the squares turn grey and black as the mark phase reaches them, which is
 * the whole of Phase 7 in one picture.
 */
function renderHeap() {
  const view = snap === null ? null : snap.heap;
  ui.heapPane.hidden = view === null;
  if (view === null) return;

  const held = view.held > 0 ? ` · ${view.held} held by history` : '';
  const phase = view.step === null ? '' : ` · ${view.step.phase}ing #${view.step.addr}`;
  ui.heapCount.textContent = `${view.live} live · ${view.size} slots · ${view.collections} collected${held}${phase}`;

  const grid = document.createDocumentFragment();
  for (const cell of view.cells) {
    const square = document.createElement('i');
    square.className = `cell cell-${cell.kind}`;
    if (cell.pinned) square.classList.add('cell-pinned');
    if (cell.history) square.classList.add('cell-history');
    if (cell.color === GREY) square.classList.add('cell-grey');
    if (cell.color === BLACK) square.classList.add('cell-black');
    if (view.step !== null && view.step.addr === cell.addr) square.classList.add('cell-at');
    square.title = `#${cell.addr} ${cell.label}`;
    grid.append(square);
  }
  ui.heap.replaceChildren(grid);
}

/**
 * The call stack, drawn in the order `stackTrace` sends it: innermost first,
 * bottoming out at the program itself. Once something has failed the adapter
 * substitutes the stack from the moment it failed — the live one has already
 * unwound to nothing, and showing that is the same as showing nothing.
 */
function renderStack() {
  ui.stack.replaceChildren();
  for (const frame of snap === null ? [] : snap.frames) {
    const row = document.createElement('div');
    // The bottom frame is the program, which was never called from anywhere
    // and has no line worth quoting.
    if (frame.id === 0) {
      row.className = 'frame top';
      row.append(span('name', frame.name));
    } else {
      row.className = 'frame';
      row.append(span('name', frame.name), document.createTextNode(' '), span('where', `line ${frame.line}`));
    }
    ui.stack.append(row);
  }
}

/**
 * The instruction listing, on a backend that has one. The tree-walker has no
 * instructions, so the pane and its column go away rather than sitting there
 * empty — the layout says which backend is running before the switch does.
 */
function renderCode() {
  const code = snap === null ? null : snap.code;
  ui.codePane.hidden = code === null;
  ui.main.classList.toggle('with-code', code !== null);
  if (code === null) {
    ui.code.replaceChildren();
    ui.codeTitle.textContent = '';
    return;
  }

  ui.codeTitle.textContent = code.title;
  ui.code.replaceChildren();
  /** @type {HTMLElement|null} */
  let currentRow = null;
  for (const line of code.instructions) {
    const row = document.createElement('div');
    row.className = line.address === code.address ? 'ins current' : 'ins';
    // The comment half is the operand spelled out; dimming it keeps the
    // opcode column readable as a column.
    const [instruction, comment] = splitNote(line.instruction);
    row.append(document.createTextNode(instruction));
    if (comment !== null) row.append(span('note', comment));
    ui.code.append(row);
    if (line.address === code.address) currentRow = row;
  }
  if (currentRow !== null) currentRow.scrollIntoView({ block: 'nearest' });
}

/**
 * @param {string} text
 * @returns {[string, string|null]}
 */
function splitNote(text) {
  const at = text.indexOf('  ; ');
  return at === -1 ? [text, null] : [text.slice(0, at), text.slice(at)];
}

function renderBackend() {
  for (const button of ui.backend.querySelectorAll('button')) {
    const selected = button.dataset.backend === backendName;
    button.setAttribute('aria-pressed', String(selected));
  }
}

function renderStatus() {
  if (loadError !== null) {
    ui.status.textContent = loadError.label;
    show(ui.failure, loadError.message);
    return;
  }
  if (snap === null) return;
  const state = snap.state;

  if (state.failure !== null) {
    show(ui.failure, `${state.failure.message} (${where(state.failure.span.start)})`);
  } else {
    hide(ui.failure);
  }

  // "running" is a status the page could not previously be in: the run held
  // the thread, so there was no moment at which it could be drawn.
  const parts = [`<b>${state.running ? 'running' : state.status}</b>`, `step ${state.stepCount}`];
  if (state.line !== null) {
    parts.push(`line ${state.line}`, `${state.phase} ${state.label}`);
  }
  if (state.status === 'done') parts.push(`result ${state.result}`);
  ui.status.innerHTML = parts.join(' &middot; ');
}

function render() {
  renderSource();
  renderRibbon();
  renderCode();
  renderBackend();
  renderScopes();
  renderStack();
  renderHeap();
  renderStatus();
  ui.output.textContent = snap === null ? '' : snap.state.output.join('\n');

  const state = snap?.state ?? null;
  const running = state?.running === true;
  const live = state !== null && state.loaded && state.canStep && !running && !editing;
  buttons.back.disabled = state === null || editing || running || !state.canStepBack;
  buttons.step.disabled = !live;
  buttons.stepLine.disabled = !live;
  buttons.stepOver.disabled = !live;
  // The one control that stays live mid-run, because it is the one that ends
  // one. Nothing else can be asked for while the far side is stepping.
  buttons.run.disabled = !live && !running;
  buttons.run.textContent = running ? 'pause' : 'run';
  buttons.reset.disabled = state === null || editing || running;

  const collecting = state?.collecting === true;
  buttons.gcStep.disabled = snap === null || snap.heap === null || editing || running;
  buttons.gcStep.textContent = collecting ? 'next' : 'collect';
  buttons.gcFinish.hidden = !collecting;

  ui.source.hidden = editing;
  ui.editor.hidden = !editing;
  ui.edit.textContent = editing ? 'load' : 'edit';
  ui.edit.setAttribute('aria-pressed', String(editing));
}

/**
 * @param {string} className
 * @param {string} text
 * @returns {HTMLElement}
 */
function span(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
function note(text) {
  return span('empty', text);
}

/**
 * @param {HTMLElement} node
 * @param {string} text
 */
function show(node, text) {
  node.textContent = text;
  node.hidden = false;
}

/** @param {HTMLElement} node */
function hide(node) {
  node.hidden = true;
}

/**
 * Send one request and redraw.
 *
 * A motion answers before it has moved, so this redraw is the one that puts
 * the page into its running state; the redraw that shows where it stopped is
 * the `stopped` event's. A control that used to be "move the debugger, then
 * render" is now two renders around a wait.
 * @param {string} command
 * @param {any} [args]
 * @returns {Promise<void>}
 */
async function send(command, args) {
  if (editing || snap === null) return;
  try {
    await client.request(command, args);
  } catch (err) {
    // A refused request — a motion while one is already running, a stale
    // reference — is not worth a dialog. The redraw below says what the
    // adapter actually thinks is going on, which is the useful answer.
    console.warn(`${command}:`, err);
  }
  await refresh();
}

const actions = {
  back: () => send('stepBack'),
  step: () => send('stepIn'),
  stepLine: () => send('stepIn', { granularity: 'line' }),
  stepOver: () => send('next'),
  // One button, two commands. Running is now a state the page can be in
  // rather than a call it makes, so the control that starts it is also the
  // control that ends it.
  run: () => send(snap?.state.running === true ? 'pause' : 'continue'),
  reset: () => send('restart'),
  gcStep: () => send('pip/collect'),
  gcFinish: () => send('pip/collect', { finish: true }),
};

buttons.back.addEventListener('click', actions.back);
buttons.step.addEventListener('click', actions.step);
buttons.stepLine.addEventListener('click', actions.stepLine);
buttons.stepOver.addEventListener('click', actions.stepOver);
buttons.run.addEventListener('click', actions.run);
buttons.reset.addEventListener('click', actions.reset);
buttons.gcStep.addEventListener('click', actions.gcStep);
buttons.gcFinish.addEventListener('click', actions.gcFinish);

// The adapter volunteers these; nothing here asked for them. A run started
// minutes ago hitting a breakpoint arrives the same way as a step landing,
// which is what makes the page a client rather than a caller.
client.on('stopped', () => void refresh());
client.on('terminated', () => void refresh());
client.on('pip/crashed', (/** @type {{message: string}} */ body) => {
  loadError = { label: 'adapter crashed', message: body.message };
  render();
});

ui.edit.addEventListener('click', async () => {
  if (editing) {
    editing = false;
    // Source that doesn't parse leaves you in the editor rather than staring
    // at an empty pane with the text you have to fix hidden behind a button.
    if (!(await load(ui.editor.value))) {
      editing = true;
      render();
      ui.editor.focus();
    }
    return;
  }
  editing = true;
  ui.editor.value = source;
  render();
  ui.editor.focus();
});

ui.showEmpty.addEventListener('change', render);

// Switching backend restarts the program on the other one, with the same
// source and the same breakpoints. Comparing the two on one program is the
// reason both are still here.
ui.backend.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const name = target.dataset.backend;
  if (name === undefined || name === backendName) return;
  backendName = name;
  if (editing) {
    renderBackend();
    return;
  }
  if (snap === null || !snap.state.loaded) await load(ui.editor.value);
  else await send('pip/backend', { backend: name });
});

// The canvas is sized in CSS pixels, so a resize needs a redraw at the new
// backing-store dimensions or the ribbon goes soft. A wider strip also holds
// more columns than were asked for, so the trace window is re-requested.
window.addEventListener('resize', () => void refresh());

// Clicking a column goes back to the step it draws. The ribbon then gets
// shorter, which is the honest thing for it to do: it is a record of what has
// happened, and after a step back the columns to the right have not happened.
ui.ribbon.addEventListener('click', (event) => {
  if (editing || ribbonView === null || snap?.state.running === true) return;
  const { start, column, count, dropped } = ribbonView;
  const index = Math.floor((event.clientX - ui.ribbon.getBoundingClientRect().left) / column);
  if (index < 0 || index >= count) return;
  // Column to step number: the window starts partway into the trace, and the
  // trace starts partway into the run once marks have fallen off the front.
  void send('pip/goto', { target: start + index + 1 + dropped });
});

ui.source.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains('gutter')) return;
  if (snap === null) return;
  const line = Number(target.dataset.line);
  const lines_ = new Set(snap.state.breakpoints);
  if (!lines_.delete(line)) lines_.add(line);
  void send('setBreakpoints', { lines: [...lines_] });
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (document.activeElement === ui.editor) return;
  /** @type {Record<string, () => Promise<void>>} */
  const keys = { b: actions.back, s: actions.step, l: actions.stepLine, o: actions.stepOver, r: actions.run, e: actions.reset };
  const action = keys[event.key.toLowerCase()];
  if (action === undefined) return;
  event.preventDefault();
  void action();
});

void load(ui.editor.value);

// @ts-check
import { Debugger, inspect } from './driver.js';

/** @typedef {import('../src/parser.js').Span} Span */
/** @typedef {import('./driver.js').Frame} Frame */

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
};

/** Pixels per step in the ribbon: it stretches between these to fill the strip. */
const MIN_COLUMN = 2;
const MAX_COLUMN = 10;

/** @type {Record<string, HTMLButtonElement>} */
const buttons = {
  step: /** @type {HTMLButtonElement} */ (el('step')),
  stepLine: /** @type {HTMLButtonElement} */ (el('step-line')),
  stepOver: /** @type {HTMLButtonElement} */ (el('step-over')),
  run: /** @type {HTMLButtonElement} */ (el('run')),
  reset: /** @type {HTMLButtonElement} */ (el('reset')),
};

/** @type {Debugger|null} */
let dbg = null;
let editing = false;
/** @type {string|null} */
let parseError = null;

/**
 * Rebuild the debugger around new source, carrying breakpoints across so
 * editing a line doesn't silently drop the marks you set.
 * @param {string} source
 * @returns {boolean} whether the source parsed
 */
function load(source) {
  const breakpoints = dbg === null ? [] : [...dbg.breakpoints];
  try {
    dbg = new Debugger(source, { breakpoints });
    parseError = null;
  } catch (err) {
    dbg = null;
    parseError = err instanceof Error ? err.message : String(err);
  }
  render();
  return parseError === null;
}

/**
 * 1-based line and column of a source index, for error reporting.
 * @param {Debugger} debug
 * @param {number} index
 * @returns {string}
 */
function where(debug, index) {
  const line = debug.lineOf(index);
  return `line ${line}, col ${index - debug.lineStarts[line - 1] + 1}`;
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
  if (dbg === null) return;
  const span = dbg.current === null ? null : dbg.current.node.span;
  const currentLine = dbg.line;

  dbg.lines.forEach((text, index) => {
    const line = index + 1;
    const row = document.createElement('div');
    row.className = line === currentLine ? 'row current' : 'row';

    const gutter = document.createElement('button');
    gutter.className = dbg?.breakpoints.has(line) ? 'gutter breakpoint' : 'gutter';
    gutter.dataset.line = String(line);
    gutter.textContent = String(line);

    const code = document.createElement('div');
    code.className = 'code';
    paintLine(code, text, /** @type {Debugger} */ (dbg).lineStarts[index], span);

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

  if (dbg === null || dbg.trace.length === 0) {
    ui.ribbonCount.textContent = '';
    return;
  }

  // Columns widen to fill the strip while a run is short, so a fresh program
  // reads as a skyline rather than a smudge in the corner. Once the trace is
  // long enough to overflow at the minimum width, the view becomes a window
  // onto the most recent steps instead.
  let column;
  let start;
  if (dbg.trace.length * MIN_COLUMN > width) {
    column = MIN_COLUMN;
    start = dbg.trace.length - Math.floor(width / column);
  } else {
    column = Math.min(MAX_COLUMN, width / dbg.trace.length);
    start = 0;
  }

  const window_ = dbg.trace.slice(start);
  const deepest = Math.max(...window_.map((mark) => mark.depth), 1);
  const usable = height - 8;

  // Columns butt up against each other rather than leaving a gap, so the tops
  // join into one continuous edge and the shape reads as a silhouette.
  const span = column + 0.5;

  window_.forEach((mark, index) => {
    const x = index * column;
    const y = base - Math.round((mark.depth / deepest) * usable);

    ctx.fillStyle = ink('--sel');
    ctx.fillRect(x, y, span, base - y);

    ctx.fillStyle = mark.phase === 'enter' ? ink('--enter') : ink('--exit');
    ctx.fillRect(x, y, span, 2);

    if (dbg?.breakpoints.has(mark.line)) {
      ctx.fillStyle = ink('--stop');
      ctx.fillRect(x, base - 2, span, 2);
    }
  });

  // The cursor sits on the last column, which is where execution is paused.
  const cursor = (window_.length - 1) * column;
  ctx.fillStyle = ink('--fg');
  ctx.fillRect(cursor, 0, 1, height);

  const dropped = dbg.dropped > 0 ? `, ${dbg.dropped} dropped` : '';
  ui.ribbonCount.textContent = `${dbg.stepCount} steps, depth ${dbg.depth}${dropped}`;
}

function renderScopes() {
  ui.scopes.replaceChildren();
  if (dbg === null || dbg.current === null) {
    ui.scopes.append(note('nothing running'));
    return;
  }
  // A call pushes two scopes, one for the parameters and one for the body
  // block, and a closure chain stacks several of them. The empty ones are
  // real, but three blank boxes above the scope you came to read is a poor
  // first impression, so they are off by default rather than gone.
  const scopes = dbg.scopes().filter((scope) => ui.showEmpty.checked || scope.bindings.length > 0);
  for (const scope of scopes) {
    const block = document.createElement('div');
    block.className = 'scope';

    const label = document.createElement('div');
    label.className = 'scope-label';
    label.textContent = scope.label;
    block.append(label);

    if (scope.bindings.length === 0) {
      block.append(note('empty'));
    } else {
      for (const binding of scope.bindings) {
        const row = document.createElement('div');
        row.className = 'binding';
        row.append(span('name', binding.name), span('value', inspect(binding.value)));
        block.append(row);
      }
    }
    ui.scopes.append(block);
  }
}

function renderStack() {
  ui.stack.replaceChildren();
  // Once something has failed, the interesting stack is the one from the
  // moment it failed. The live stack has already unwound to nothing by then,
  // and showing that is the same as showing nothing at all.
  const frames = dbg === null ? [] : dbg.failure?.stack ?? dbg.stack;
  // Innermost first, the way a stack trace reads.
  for (const frame of [...frames].reverse()) {
    ui.stack.append(frameRow(frame));
  }
  const bottom = document.createElement('div');
  bottom.className = 'frame top';
  bottom.append(span('name', '(top level)'));
  ui.stack.append(bottom);
}

/**
 * @param {Frame} frame
 * @returns {HTMLElement}
 */
function frameRow(frame) {
  const row = document.createElement('div');
  row.className = 'frame';
  row.append(span('name', frame.name), document.createTextNode(' '), span('where', `line ${frame.line}`));
  return row;
}

function renderStatus() {
  if (parseError !== null) {
    ui.status.textContent = 'parse error';
    show(ui.failure, parseError);
    return;
  }
  if (dbg === null) return;

  if (dbg.failure !== null) {
    show(ui.failure, `${dbg.failure.message} (${where(dbg, dbg.failure.node.span.start)})`);
  } else {
    hide(ui.failure);
  }

  const parts = [`<b>${dbg.status}</b>`, `step ${dbg.stepCount}`];
  if (dbg.current !== null) {
    parts.push(`line ${dbg.line}`, `${dbg.current.phase} ${dbg.current.node.type}`);
  }
  if (dbg.status === 'done') parts.push(`result ${inspect(dbg.result)}`);
  ui.status.innerHTML = parts.join(' &middot; ');
}

function render() {
  renderSource();
  renderRibbon();
  renderScopes();
  renderStack();
  renderStatus();
  ui.output.textContent = dbg === null ? '' : dbg.output.join('\n');

  const live = dbg !== null && dbg.canStep && !editing;
  buttons.step.disabled = !live;
  buttons.stepLine.disabled = !live;
  buttons.stepOver.disabled = !live;
  buttons.run.disabled = !live;
  buttons.reset.disabled = dbg === null || editing;

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
 * Every control does the same two things: move the debugger, then redraw.
 * @param {(debug: Debugger) => void} move
 */
function control(move) {
  return () => {
    if (dbg === null || editing) return;
    move(dbg);
    render();
  };
}

const actions = {
  step: control((debug) => debug.step()),
  stepLine: control((debug) => debug.stepLine()),
  stepOver: control((debug) => debug.stepOver()),
  run: control((debug) => debug.run()),
  reset: control((debug) => debug.reset()),
};

buttons.step.addEventListener('click', actions.step);
buttons.stepLine.addEventListener('click', actions.stepLine);
buttons.stepOver.addEventListener('click', actions.stepOver);
buttons.run.addEventListener('click', actions.run);
buttons.reset.addEventListener('click', actions.reset);

ui.edit.addEventListener('click', () => {
  if (editing) {
    editing = false;
    // Source that doesn't parse leaves you in the editor rather than staring
    // at an empty pane with the text you have to fix hidden behind a button.
    if (!load(ui.editor.value)) {
      editing = true;
      render();
      ui.editor.focus();
    }
    return;
  }
  editing = true;
  if (dbg !== null) ui.editor.value = dbg.source;
  render();
  ui.editor.focus();
});

ui.showEmpty.addEventListener('change', render);

// The canvas is sized in CSS pixels, so a resize needs a redraw at the new
// backing-store dimensions or the ribbon goes soft.
window.addEventListener('resize', renderRibbon);

ui.source.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains('gutter')) return;
  if (dbg === null) return;
  dbg.toggleBreakpoint(Number(target.dataset.line));
  render();
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (document.activeElement === ui.editor) return;
  /** @type {Record<string, () => void>} */
  const keys = { s: actions.step, l: actions.stepLine, o: actions.stepOver, r: actions.run, e: actions.reset };
  const action = keys[event.key.toLowerCase()];
  if (action === undefined) return;
  event.preventDefault();
  action();
});

load(ui.editor.value);

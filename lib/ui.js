// chatkit — small terminal prompts (no dependencies). One reader is shared by
// every prompt; release() hands the terminal to a child process (the QR code,
// the Telegram login) and the next prompt takes it back.
import readline from "node:readline";

let rl = null;
let muted = false;
// Lines typed (or piped) before a prompt asks for them wait here.
const lines = [];
const waiting = [];

function reader() {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const write = rl._writeToOutput?.bind(rl);
  if (write) rl._writeToOutput = (s) => (muted ? undefined : write(s));
  rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on("close", () => {
    rl = null;
    while (waiting.length) waiting.shift()("");
  });
  return rl;
}

export function release() {
  if (!rl) return;
  rl.close();
  rl = null;
}

function question(q) {
  const r = reader();
  process.stdout.write(q);
  if (lines.length) {
    const l = lines.shift();
    if (!muted && !process.stdin.isTTY) process.stdout.write(l + "\n");
    return Promise.resolve(l.trim());
  }
  return new Promise((resolve) => waiting.push((l) => resolve(String(l).trim())));
}

export async function ask(q, def = "") {
  return (await question(`${q}${def ? ` [${def}]` : ""} `)) || def;
}

export async function yes(q, def = false) {
  const a = (await ask(`${q} ${def ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  return a ? a.startsWith("y") : def;
}

// Typed characters are not echoed: for API keys.
export async function secret(q) {
  process.stdout.write(`${q} `);
  muted = true;
  try {
    return await question("");
  } finally {
    muted = false;
    process.stdout.write("\n");
  }
}

// One of several options; returns the option's value.
export async function choose(q, options, def = 1) {
  console.log(q);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  for (;;) {
    const a = Number(await ask("Choose a number:", String(def)));
    if (a >= 1 && a <= options.length) return options[a - 1].value;
  }
}

export const step = (n, text) => console.log(`\n── ${n} · ${text} ${"─".repeat(Math.max(4, 56 - text.length))}`);

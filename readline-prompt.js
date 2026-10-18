'use strict';

const readline = require('readline');

let rl;
let lines;
let asking = false;

function getLines() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Created at once, so lines piped before a question wait for it
    lines = rl[Symbol.asyncIterator]();
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      rl.close();
      // Outside a question Ctrl-C must interrupt the work, as it does without readline
      if (!asking) process.kill(process.pid, 'SIGINT');
    });
  }
  return lines;
}

async function ask(message, singleKey) {
  const answers = getLines();
  // In a terminal y or n answers without Enter, as with prompts
  const answerOnKey = () => {
    if (/^[yn]$/i.test(rl.line)) rl.write(null, { name: 'return' });
  };
  // Removed on the line itself: the rest of a pasted chunk belongs to the next question
  const stopKeys = () => process.stdin.off('keypress', answerOnKey);
  if (singleKey && process.stdin.isTTY) {
    process.stdin.on('keypress', answerOnKey);
    rl.once('line', stopKeys);
  }
  rl.setPrompt(message + ' ');
  rl.prompt();
  asking = true;
  try {
    const { value, done } = await answers.next();
    return done ? undefined : value;
  } finally {
    asking = false;
    stopKeys();
    rl.off('line', stopKeys);
  }
}

async function confirm(message, initial) {
  const suffix = initial ? '(Y/n)' : '(y/N)';
  while (true) {
    const answer = await ask(message + ' ' + suffix, true);
    if (answer === undefined) return undefined;
    const value = answer.trim().toLowerCase();
    if (!value) return Boolean(initial);
    if (value === 'y' || value === 'yes') return true;
    if (value === 'n' || value === 'no') return false;
    process.stdout.write('Please answer y or n.\n');
  }
}

function text(message) {
  return ask(message);
}

function close() {
  if (rl) rl.close();
}

module.exports = { confirm, text, close };

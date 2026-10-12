// 静态引用体检：找出「被调用/被引用但从未声明」的顶层标识符（抓拼写错误）
const fs = require('fs');
const path = process.argv[2];
const raw = fs.readFileSync(path, 'utf8');
const src = raw.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');

// 粗略剥离字符串与注释，避免误报
const stripped = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const declared = new Set();
const declRe = /(?:^|[\s;{}(,])(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/g;
let m;
while ((m = declRe.exec(stripped))) declared.add(m[1] || m[2]);

// 函数参数 / catch 参数 / 解构名也算声明（保守起见全部收集）
const paramRe = /(?:function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|catch\s*\(([^)]*)\))/g;
while ((m = paramRe.exec(stripped))) {
  for (const grp of [m[1], m[2], m[3]]) {
    if (!grp) continue;
    grp.split(',').forEach((p) => {
      const n = p.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
    });
  }
}

const GLOBALS = new Set([
  'window','document','console','performance','setTimeout','clearTimeout','setInterval','clearInterval',
  'requestAnimationFrame','cancelAnimationFrame','requestIdleCallback','MutationObserver','KeyboardEvent',
  'MouseEvent','PointerEvent','Event','CustomEvent','URL','location','history','navigator','Promise',
  'WeakMap','WeakSet','Map','Set','Array','Object','JSON','Math','Number','String','Boolean','Date',
  'Error','RegExp','Symbol','Proxy','Reflect','BigInt','Infinity','NaN','undefined','null','true','false',
  'getComputedStyle','Element','HTMLElement','Node','NodeList','DOMParser','structuredClone','queueMicrotask',
  'if','for','while','switch','catch','return','typeof','new','delete','void','in','of','do','else','try',
  'finally','throw','case','break','continue','function','class','const','let','var','this','super','import',
  'export','default','await','async','yield','instanceof','static','get','set','extends','require','module',
]);

const used = new Map();
const callRe = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
while ((m = callRe.exec(stripped))) {
  const n = m[1];
  if (!used.has(n)) used.set(n, 0);
  used.set(n, used.get(n) + 1);
}

const missing = [...used.keys()].filter((n) => !declared.has(n) && !GLOBALS.has(n)).sort();
console.log('declared top-level:', declared.size);
console.log('distinct called names:', used.size);
if (missing.length) {
  console.log('\n!! 可能未声明（需人工确认）:');
  for (const n of missing) console.log('   -', n, 'x' + used.get(n));
} else {
  console.log('\nOK: 所有被调用的标识符都有声明或是已知全局。');
}

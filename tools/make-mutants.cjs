// 用 node 精确生成变异体，避免 PowerShell 字符串处理破坏文件
const fs = require('fs');
const p = require('path');
const src = fs.readFileSync(p.resolve(__dirname, '..', 'x-quick-block.user.js'), 'utf8');

const A = src.replace('      el.click();\n', '      /* MUTANT: realClick 失效 */ void 0;\n');
if (A === src) throw new Error('mutant A 未命中');
fs.writeFileSync(p.resolve(__dirname, 'mutantA.user.js'), A);

const B = src.replace(/blockRe: \/[\s\S]*?\/i,/, 'blockRe: /(?!)/,');
if (B === src) throw new Error('mutant B 未命中');
fs.writeFileSync(p.resolve(__dirname, 'mutantB.user.js'), B);

// C：去掉二次确认（把 popover 当成 none 处理），用于确认测试能抓到「误触」
const C = src.replace("confirmMode: 'popover',", "confirmMode: 'none',");
if (C === src) throw new Error('mutant C 未命中');
fs.writeFileSync(p.resolve(__dirname, 'mutantC.user.js'), C);

console.log('mutants written: A(realClick), B(文案兜底), C(去掉二次确认)');

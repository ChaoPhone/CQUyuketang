// 静态检查：赋值给未声明标识符（会在严格模式下抛 ReferenceError）
// 用法: node scripts/static-check.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'cqu-yuketang.user.js'), 'utf8');

const declared = new Set();
const add = n => { if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n); };

// --- 声明收集 ---
for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}/g)) {
  for (const p of m[1].split(',')) add((p.split(':').pop() || '').trim().replace(/=.*$/, '').trim());
}
for (const m of src.matchAll(/\b(?:const|let|var)\s*\[([^\]]+)\]/g)) {
  for (const p of m[1].split(',')) add(p.trim().replace(/=.*$/, '').trim());
}
for (const m of src.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
  for (const p of m[1].split(',')) add(p.replace(/=.*$/s, '').trim());
}
// 无括号的箭头函数单参：x => ...
for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
// 带默认值的形参（含解构内部）：从参数列表整体提取
for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
  for (const p of m[1].split(',')) {
    const inner = p.match(/\{([^}]*)\}/);
    if (inner) for (const q of inner[1].split(',')) add((q.split(':').pop() || '').replace(/=.*$/, '').trim());
  }
}
for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
for (const m of src.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) add(m[1]);

// --- 运行环境全局 ---
const GLOBALS = `globalThis undefined NaN Infinity Object Function Boolean Symbol Error
RangeError ReferenceError TypeError URIError Number BigInt Math Date String RegExp Array
Map Set WeakMap WeakSet WeakRef ArrayBuffer DataView JSON Promise Reflect Proxy Intl
parseInt parseFloat isNaN isFinite decodeURI decodeURIComponent encodeURI encodeURIComponent
window self document location navigator history screen frames parent top localStorage
sessionStorage indexedDB caches console setTimeout clearTimeout setInterval clearInterval
queueMicrotask requestAnimationFrame cancelAnimationFrame getComputedStyle matchMedia
alert confirm prompt open close focus blur scroll scrollTo scrollBy postMessage
addEventListener removeEventListener dispatchEvent structuredClone atob btoa
MutationObserver IntersectionObserver ResizeObserver PerformanceObserver
Node NodeList NodeFilter Element HTMLElement HTMLMediaElement HTMLVideoElement Document
ShadowRoot Event CustomEvent MouseEvent KeyboardEvent PointerEvent UIEvent EventTarget
AbortController AbortSignal URL URLSearchParams Blob File FileReader FormData Headers
Request Response fetch XMLHttpRequest WebSocket Worker TextEncoder TextDecoder DOMParser
Image Audio CSS getSelection Range TreeWalker Notification ClipboardEvent DataTransfer
SVGElement DOMRect DOMTokenList Attr CharacterData Text Comment HTMLCollection
crypto isSecureContext devicePixelRatio innerWidth innerHeight frameElement
unsafeWindow GM_xmlhttpRequest GM_info GM_setValue GM_getValue GM_addStyle GM_setClipboard
Tesseract html2canvas`.split(/\s+/).filter(Boolean);
for (const g of GLOBALS) declared.add(g);

// --- 剥离字符串 / 模板 / 注释 / 正则，保留换行以维持行号 ---
function strip(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  const nl = s => (s.match(/\n/g) || []).join('');
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];
    if (c === '/' && c2 === '/') { const s = i; while (i < n && code[i] !== '\n') i++; out += nl(code.slice(s, i)); }
    else if (c === '/' && c2 === '*') { const s = i; i += 2; while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; out += nl(code.slice(s, Math.min(i, n))); }
    else if (c === "'" || c === '"' || c === '`') {
      const q = c; const s = i; i++;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === q) { i++; break; }
        if (q === '`' && code[i] === '$' && code[i + 1] === '{') {
          let d = 1; i += 2; const s2 = i;
          while (i < n && d > 0) { if (code[i] === '{') d++; else if (code[i] === '}') d--; if (d > 0) i++; }
          out += nl(code.slice(s, s2)) + ' ' + strip(code.slice(s2, i)) + ' ';
          i++; continue;
        }
        i++;
      }
      out += nl(code.slice(s, Math.min(i, n)));
    } else if (c === '/' && /[=(,:[!&|?{};+\-*%~^]\s*$/.test(out)) {
      const s = i; i++; let inClass = false;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        else if (code[i] === '/' && !inClass) { i++; break; }
        else if (code[i] === '\n') break;
        i++;
      }
      while (i < n && /[a-z]/.test(code[i])) i++;
      out += nl(code.slice(s, Math.min(i, n)));
    } else { out += c; i++; }
  }
  return out;
}

const code = strip(src);
const bad = [];
for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
  const name = m[1];
  const before = code.slice(Math.max(0, m.index - 40), m.index);
  const after = code.slice(m.index + m[0].length);

  if (declared.has(name)) continue;
  if (/[.\w$]\s*$/.test(before)) continue;                    // 属性赋值 a.b =
  if (/\b(?:const|let|var|function|class)\s*$/.test(before)) continue;
  if (/[({,[]\s*$/.test(before)) continue;                    // 解构 / 数组 / 形参默认值
  if (/^\s*>/.test(after)) continue;                          // 箭头函数  x => ...
  if (/\b(?:const|let|var)\s*$/.test(before)) continue;

  bad.push({
    name,
    line: code.slice(0, m.index).split('\n').length,
    snippet: code.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ').trim(),
  });
}

console.log(`已识别声明: ${declared.size} 个`);
if (bad.length) {
  console.log('\n✗ 赋值给未声明标识符（严格模式下会抛 ReferenceError）:');
  for (const b of bad) console.log(`    第 ${b.line} 行: ${b.name}\n      … ${b.snippet} …`);
  process.exit(1);
}
console.log('✓ 未发现「赋值给未声明标识符」');

'use strict';

// CSV 公式注入防护：以 = + - @（以及 Tab/CR）开头的单元格会被
// Excel / LibreOffice 当作公式执行（如 =HYPERLINK、=cmd|...）。
// 统一前置一个单引号，使其按文本处理；单引号是表格软件约定的文本前缀，
// 不影响原内容中的引号、逗号、换行与中文。仅作用于 CSV 输出。
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

function sanitizeFormula(value) {
  const s = value == null ? '' : String(value);
  if (s.length > 0 && FORMULA_TRIGGERS.has(s[0])) {
    return `'${s}`;
  }
  return s;
}

// RFC 4180 风格 CSV：先做公式注入防护，再对含逗号/引号/换行的字段加双引号并转义内部引号；
// 输出带 UTF-8 BOM，确保 Excel 打开中文不乱码。
function escapeCell(value) {
  const s = sanitizeFormula(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows) {
  const lines = rows.map((row) => row.map(escapeCell).join(','));
  return '﻿' + lines.join('\r\n'); // UTF-8 BOM，供 Excel 正确识别中文
}

module.exports = { toCsv, escapeCell, sanitizeFormula };

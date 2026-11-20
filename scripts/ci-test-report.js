// CI only: turn the test runner's failures into GitHub annotations, so a red run can be read without downloading the log.
// Usage: node scripts/ci-test-report.js <test output file>
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
const blocks = [];
for (let i = 0; i < lines.length && blocks.length < 8; i++) {
  if (/^\s*(not ok |\u2716 )/.test(lines[i])) blocks.push(lines.slice(i, i + 40).join('\n'));
}
if (!blocks.length) blocks.push(lines.slice(-60).join('\n'));
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
for (const b of blocks) console.log('::error title=Tests::' + esc(b.slice(0, 3500)));

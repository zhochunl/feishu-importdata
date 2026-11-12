import fs from 'node:fs';

const file = process.argv[2];
const s = fs.readFileSync(file, 'utf8');
for (const pat of process.argv.slice(3)) {
  let from = 0;
  let count = 0;
  while (count < 3) {
    const i = s.indexOf(pat, from);
    if (i < 0) break;
    console.log(`=== ${pat} @${i}`);
    console.log(s.slice(Math.max(0, i - 200), i + 300));
    from = i + pat.length;
    count++;
  }
}
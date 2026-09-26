// Озвучка всех английских фраз тренажёра голосом macOS (say) → mp3 → audio/*.json (base64).
// Запуск из корня проекта: node tools/build-audio.js
// Нужны: macOS `say` с голосом Samantha и ffmpeg.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
const D = new Function(src + '; return { WORDS, GRAMMAR, SCENES, TEXTS, PHRASE_WORDS, thisIs, COUNTABLE, NUM };')();

const words = new Set(), sentences = new Set();
D.WORDS.forEach(w => words.add(w.en));
D.PHRASE_WORDS.forEach(w => words.add(D.thisIs(w)));
D.WORDS.filter(w => w.t === 'colors').forEach(c => words.add(`It is ${c.en}.`));
D.COUNTABLE.forEach(([pl]) => [2, 3, 4].forEach(n => words.add(`There are ${D.NUM[n]} ${pl}.`)));
Object.values(D.GRAMMAR).flat().forEach(it => sentences.add(it.w ? it.w + it.end : it.s.replace('___', it.o[0])));
D.SCENES.forEach(s => sentences.add(s.s));
D.TEXTS.forEach(t => sentences.add(t.text));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stupenki-'));
const outDir = path.join(root, 'audio');
fs.mkdirSync(outDir, { recursive: true });

function build(set, file) {
  const out = {};
  let i = 0;
  for (const text of set) {
    const aiff = path.join(tmp, `${i}.aiff`), mp3 = path.join(tmp, `${i}.mp3`);
    execFileSync('say', ['-v', 'Samantha', '-r', '165', '-o', aiff, text]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '22050', '-b:a', '32k', mp3]);
    out[text] = fs.readFileSync(mp3).toString('base64');
    i++;
  }
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(out));
  console.log(file, set.size, 'клипов,', Math.round(fs.statSync(path.join(outDir, file)).size / 1024), 'КБ');
}
build(words, 'words.json');
build(sentences, 'sentences.json');

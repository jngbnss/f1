/**
 * Team radio check: every line, in both languages, with sample numbers, finds
 * all its voice clips under public/ (same file names as scripts/radio/generate.py).
 *
 *   npx tsx scripts/radio-test.ts
 */
import { existsSync } from 'node:fs';
import { clipFile, clipSequence, RADIO_LINES, radioText, type RadioLang } from '../src/audio/TeamRadio';

let missing = 0;
let clips = 0;
for (const lang of ['en', 'ko'] as RadioLang[])
  for (const id of RADIO_LINES)
    for (const vars of [{ pos: 1, gap: 0.4 }, { pos: 13, gap: 12.7 }, { pos: 20, gap: 99.9 }]) {
      for (const text of clipSequence(id, vars, lang)) {
        clips++;
        if (!existsSync(new URL(`../public/${clipFile(lang, text)}`, import.meta.url))) {
          missing++;
          console.log(`  missing ${lang} "${text}" (${id}: ${radioText(id, vars, lang)})`);
        }
      }
    }
console.log(`${RADIO_LINES.length} lines x 2 languages: ${clips} clip uses, ${missing} missing`);
if (missing) process.exit(1);
console.log('RADIO OK');

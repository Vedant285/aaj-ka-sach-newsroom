import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { assert } from './core.mjs';

const categories = { up: 'उत्तर प्रदेश', uk: 'उत्तराखंड', delhi: 'दिल्ली', world: 'विश्व', dharma: 'धर्म', business: 'व्यापार', sports: 'खेल', others: 'अन्य समाचार', mystery: 'खोज और रहस्य', lifestyle: 'जीवनशैली' };
let fontReady = false;

function wrapText(context, text, width) {
  const lines = [];
  let current = '';
  for (const word of text.trim().split(/\s+/u)) {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (context.measureText(word).width > width) return null;
  }
  if (current) lines.push(current);
  return lines;
}

export async function renderHeadlineCard(article, day, fileName) {
  assert(typeof article.title === 'string' && article.title.trim() && article.title.length <= 220, 'Invalid headline for card');
  assert(categories[article.category] && /^\d{4}-\d{2}-\d{2}$/.test(day), 'Invalid card category or date');
  assert(/^headline-card-[a-z]+-\d+\.png$/.test(fileName), 'Invalid headline card filename');
  if (!fontReady) {
    fontReady = Boolean(GlobalFonts.registerFromPath(fileURLToPath(new URL('./assets/NotoSansDevanagari.ttf', import.meta.url)), 'Newsroom Hindi'));
    assert(fontReady, 'Bundled Hindi font failed to load');
  }
  const canvas = createCanvas(1200, 630);
  const context = canvas.getContext('2d');
  context.fillStyle = '#f5f1e9';
  context.fillRect(0, 0, 1200, 630);
  context.fillStyle = '#a9232e';
  context.fillRect(0, 0, 1200, 12);
  context.fillStyle = '#10202d';
  context.font = 'bold 48px "Newsroom Hindi"';
  context.fillText('आज का सच', 64, 94);
  context.fillStyle = '#a9232e';
  context.font = 'bold 25px "Newsroom Hindi"';
  context.textAlign = 'right';
  context.fillText('समाचार सार', 1136, 88);
  context.textAlign = 'left';
  context.fillStyle = '#a9232e';
  context.font = 'bold 27px "Newsroom Hindi"';
  context.fillText(categories[article.category], 64, 151);
  let layout;
  for (let size = 64; size >= 34; size -= 2) {
    context.font = `bold ${size}px "Newsroom Hindi"`;
    const lines = wrapText(context, article.title, 1072);
    const lineHeight = Math.ceil(size * 1.45);
    if (lines && lines.length * lineHeight <= 315) {
      layout = { lines, lineHeight, size };
      break;
    }
  }
  assert(layout, 'Headline does not fit the card; shorten it before publication');
  context.fillStyle = '#10202d';
  const top = 180 + (315 - layout.lines.length * layout.lineHeight) / 2;
  layout.lines.forEach((line, index) => context.fillText(line, 64, top + layout.size + index * layout.lineHeight));
  context.fillStyle = '#d4c8b8';
  context.fillRect(64, 523, 1072, 2);
  context.font = '26px "Newsroom Hindi"';
  context.fillStyle = '#45515b';
  const location = article.district?.trim() || categories[article.category];
  let footerSize = 26;
  while (context.measureText(location).width > 750 && footerSize > 16) {
    context.font = `${--footerSize}px "Newsroom Hindi"`;
  }
  assert(context.measureText(location).width <= 750, 'Location does not fit the card');
  context.fillText(location, 64, 576);
  context.font = '26px "Newsroom Hindi"';
  context.textAlign = 'right';
  context.fillText(day.split('-').reverse().join('.'), 1136, 576);
  const bytes = await canvas.encode('png');
  return {
    bytes,
    image: { kind: 'headline-card', fileName, width: 1200, height: 630, sha256: createHash('sha256').update(bytes).digest('hex'), title: article.title, caption: 'समाचार सार — वास्तविक घटना की तस्वीर नहीं', license: 'Original newsroom graphic', creator: 'आज का सच' },
  };
}

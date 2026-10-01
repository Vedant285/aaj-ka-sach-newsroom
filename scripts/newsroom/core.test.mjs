import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ArticleEvidenceError, CATEGORIES, batchPlan, characterCount, creditFreeLicense, eligibleImage, IMAGE_NOTICE_BUDGET,
  imageNotice, makeDocument, photoScore, portableText, similarTitle, validateArticles, verifyPosts,
} from './core.mjs';

// Offline only: no network, no credentials. Run with `npm test`.

const image = (licenseUrl, extra = {}) => ({ mime: 'image/jpeg', width: 1280, extmetadata: { LicenseUrl: { value: licenseUrl }, ...extra } });

test('only credit-free licences are accepted', () => {
  assert.ok(creditFreeLicense('https://creativecommons.org/publicdomain/zero/1.0/'));
  assert.ok(creditFreeLicense('https://creativecommons.org/publicdomain/mark/1.0/'));
  // CC BY and CC BY-SA oblige us to publish a credit, and the website has nowhere to show one.
  assert.ok(!creditFreeLicense('https://creativecommons.org/licenses/by/4.0/'));
  assert.ok(!creditFreeLicense('https://creativecommons.org/licenses/by-sa/3.0/'));
  assert.ok(!creditFreeLicense('https://creativecommons.org/licenses/by-nc/4.0/'));
  assert.ok(!creditFreeLicense('https://example.com/publicdomain/zero/1.0/'));
  assert.ok(eligibleImage(image('https://creativecommons.org/publicdomain/zero/1.0/')));
  assert.ok(!eligibleImage(image('https://creativecommons.org/licenses/by-sa/4.0/')));
  assert.ok(!eligibleImage({ ...image('https://creativecommons.org/publicdomain/zero/1.0/'), width: 640 }));
});

test('the image notice fits the reserved body budget', () => {
  assert.ok(characterCount(imageNotice()) <= IMAGE_NOTICE_BUDGET);
  // editorial-prompt.md promises authors 2,869 characters; the runner caps body+notice at 2,900.
  assert.equal(2869 + 1 + IMAGE_NOTICE_BUDGET, 2900);
});

test('editorial prompt advertises the same ceiling the validator enforces', async () => {
  const prompt = await readFile(new URL('./editorial-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /1,500-2,869 Unicode characters/);
});

test('photoScore rejects artwork, artefacts and pre-1990 prints', () => {
  const subject = (title, extra = {}) => photoScore({ title: `File:${title}` }, { extmetadata: extra }, 'kneaded dough');
  assert.ok(subject('Kneading bread dough.jpg') > 0);
  assert.equal(subject('Female figurine kneading dough MET GR690.jpg'), 0);
  assert.equal(subject('Kneading dough, an engraving.jpg'), 0);
  assert.equal(subject('Kneading dough.jpg', { DateTimeOriginal: { value: '1909' } }), 0);
  // Stemming: the query says "kneaded", the file says "Kneading".
  assert.ok(subject('Kneading Chapati Dough 01.jpg') >= 3);
});

test('similarTitle catches reworded repeats without flagging unrelated news', () => {
  assert.ok(similarTitle(
    'गोवा में विशेष गहन पुनरीक्षण के तहत छूटे हुए मतदाताओं के नामों को जोड़ने की प्रक्रिया हुई आसान',
    'गोवा में छूटे हुए मतदाताओं के नामों को जोड़ने की प्रक्रिया आसान हुई',
  ));
  assert.ok(similarTitle('नासा के टेलीस्कोप ने नए ग्रह की खोज की', 'नासा के टेलीस्कोप ने नए ग्रह की खोज की'));
  assert.ok(!similarTitle('बिना फ्रिज के गूंथे हुए आटे को सुरक्षित रखने के पारंपरिक तरीके', 'भारतीय टीम ने सीरीज जीतकर रचा नया कीर्तिमान'));
  // Shared function words alone must never trip it.
  assert.ok(!similarTitle('उत्तर प्रदेश में नई सड़क परियोजना को मंजूरी मिली', 'उत्तराखंड में पर्यटन को बढ़ावा देने की नई योजना शुरू'));
});

const paragraph = 'क'.repeat(400);
let counter = 0;
const article = (category) => ({
  category, title: `${category} शीर्षक ${++counter}`, slug: `slug-${category}-${counter}`, district: '',
  tags: ['अ', 'ब', 'स'], sourceIds: [`${category}${String(counter).padStart(23, '0')}`], evidence: [], sources: [], image: null,
  blocks: [{ type: 'paragraph', text: paragraph }, { type: 'heading', text: 'उपशीर्षक' }, { type: 'paragraph', text: paragraph },
    { type: 'paragraph', text: paragraph }, { type: 'heading', text: 'दूसरा' }, { type: 'paragraph', text: paragraph }],
});

// Mirrors the per-category slot counter in run.mjs, which is the whole point of the test.
function buildBatch(perCategory = {}) {
  const plan = batchPlan(20);
  const slots = new Map();
  const now = new Date();
  return CATEGORIES
    .flatMap((category) => Array.from({ length: perCategory[category] ?? 2 }, () => article(category)))
    .map((item, index) => {
      const slot = (slots.get(item.category) ?? 0) + 1;
      slots.set(item.category, slot);
      return makeDocument(item, index, '2026-10-01', now, 'asset-ref', plan, slot);
    });
}

test('a short category does not shift every later article onto the wrong id', () => {
  const plan = batchPlan(20);
  const documents = buildBatch({ delhi: 1, lifestyle: 1 });
  assert.equal(documents.length, 18);
  const ids = documents.map((document) => document._id);
  assert.deepEqual(ids.filter((id) => id.includes('-delhi-')), ['newsroom-2026-10-01-delhi-1']);
  assert.deepEqual(ids.filter((id) => id.includes('-sports-')), ['newsroom-2026-10-01-sports-1', 'newsroom-2026-10-01-sports-2']);
  assert.equal(new Set(ids).size, ids.length);
  const verification = verifyPosts(documents, '2026-10-01', plan);
  assert.equal(verification.count, 18);
  assert.equal(verification.shortfall, 2);
  assert.equal(verification.perCategory.delhi, 1);
});

test('a full batch still verifies, and a batch below the minimum is rejected', () => {
  const plan = batchPlan(20);
  assert.equal(plan.minimum, 12);
  assert.equal(verifyPosts(buildBatch(), '2026-10-01', plan).shortfall, 0);
  assert.throws(() => verifyPosts(buildBatch().slice(0, 11), '2026-10-01', plan), /12-20 distinct batch post/);
});

test('published documents carry no caption and no outbound links', () => {
  const plan = batchPlan(20);
  const withImage = makeDocument({ ...article('up'), image: { kind: 'real-photo', license: 'CC0' } }, 0, '2026-10-01', new Date(), 'asset-1', plan, 1);
  assert.ok(!('caption' in withImage.mainImage));
  assert.equal(withImage.mainImage.alt, withImage.title);
  const blocks = portableText({ ...article('up'), image: { kind: 'real-photo' } });
  assert.equal(blocks.at(-1).children[0].text, imageNotice());
  assert.ok(blocks.every((block) => block.markDefs.length === 0));
});

test('every category has at least one configured feed and none is shared', async () => {
  const feeds = JSON.parse(await readFile(new URL('./feeds.json', import.meta.url), 'utf8'));
  const seen = new Map();
  for (const category of CATEGORIES) {
    assert.ok(Array.isArray(feeds[category]) && feeds[category].length, `${category} has no feed`);
    for (const url of feeds[category]) {
      // A feed shared by two categories guarantees overlapping pools, which is how
      // national stories ended up published under lifestyle.
      assert.ok(!seen.has(url), `${url} is shared by ${seen.get(url)} and ${category}`);
      seen.set(url, category);
    }
  }
});

const SOURCE_ID = 'abcdef0123456789abcdef01';
const SOURCE_TEXT = 'लखनऊ के किसानों ने इस वर्ष गेहूं की नई किस्म अपनाई है जिससे पैदावार में उल्लेखनीय वृद्धि दर्ज की गई है।';
const QUOTE = 'गेहूं की नई किस्म अपनाई है जिससे पैदावार में उल्लेखनीय वृद्धि';

const payloadFor = (quote) => ({
  articles: [{
    title: 'गेहूं की नई किस्म से किसानों की पैदावार बढ़ी',
    slug: 'wheat-variety-yield', district: '', tags: ['गेहूं', 'किसान', 'पैदावार'],
    sourceIds: [SOURCE_ID], evidence: [{ sourceId: SOURCE_ID, quote }], imageQueries: ['wheat farming'],
    blocks: [{ type: 'paragraph', text: paragraph }, { type: 'heading', text: 'उपशीर्षक' },
      { type: 'paragraph', text: paragraph }, { type: 'paragraph', text: paragraph },
      { type: 'heading', text: 'दूसरा' }, { type: 'paragraph', text: paragraph }],
  }],
  skipped: [],
});
const validate = (quote) => validateArticles(payloadFor(quote), 'up', [{ id: SOURCE_ID, url: 'https://www.amarujala.com/a', title: 'स', text: SOURCE_TEXT }], [], 1);

test('evidence must be a real quote, but re-wrapped whitespace is still a real quote', () => {
  assert.equal(validate(QUOTE)[0].sourceIds[0], SOURCE_ID);
  // The source text is whitespace-normalized on extraction, so a model that re-wraps
  // its excerpt is quoting correctly and must not lose the article over it.
  assert.ok(validate(`  ${QUOTE.replace(' ', '\n  ')}  `));
});

test('a paraphrased quote is rejected, and the rejection is retryable', () => {
  // Retryable matters as much as rejected: this failure arrived on the correction
  // attempt, where a plain Error killed the category outright.
  assert.throws(() => validate('गेहूं की एक नई किस्म से पैदावार में भारी वृद्धि हुई है'), ArticleEvidenceError);
  assert.throws(() => validate(QUOTE.slice(0, 12)), ArticleEvidenceError);
});

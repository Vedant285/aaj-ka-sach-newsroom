import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';

export const CATEGORIES = ['up', 'uk', 'delhi', 'world', 'dharma', 'business', 'sports', 'others', 'mystery', 'lifestyle'];
const SOURCE_DOMAINS = ['amarujala.com', 'bhaskar.com', 'abplive.com', 'bbc.co.uk', 'bbci.co.uk', 'bbc.com', 'sciencedaily.com', 'nasa.gov'];
export const IMAGE_DOMAINS = ['upload.wikimedia.org', 'thumb.wikimedia.org'];
// Characters reserved in the body budget for the image notice, which now carries
// the Creative Commons credit required by CC BY / CC BY-SA.
export const IMAGE_NOTICE_BUDGET = 160;
export const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24);
export const dayInIndia = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export function batchPlan(count = 20, category = 'up') {
  assert([1, 20].includes(count), 'Article count must be 1 or 20');
  assert(CATEGORIES.includes(category), 'Unknown newsroom category');
  return { count, categories: count === 1 ? [category] : CATEGORIES, perCategory: count === 1 ? 1 : 2, prefix: count === 1 ? 'newsroom-test' : 'newsroom' };
}
export const postIds = (day, plan = batchPlan()) => plan.categories.flatMap((category) => Array.from({ length: plan.perCategory }, (_, index) => `${plan.prefix}-${day}-${category}-${index + 1}`));
export const characterCount = (text) => Array.from(text).length;
export const normalize = (text) => text.replace(/\s+/g, ' ').trim();
export const plainText = (html) => normalize(load(String(html ?? '')).text());

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function safeUrl(value, domains) {
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443'), 'Only credential-free HTTPS URLs are allowed');
  assert(domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)), 'URL host is not allowed');
  return url;
}

export function canonicalSource(value) {
  const url = safeUrl(value, SOURCE_DOMAINS);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

export class QuotaError extends Error {}
export class ArticleStructureError extends Error {}
export class ArticleLengthError extends Error {}

export async function request(url, { domains, label, retries = 2, maxBytes = 3_000_000, ...options }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let current = safeUrl(url, domains);
    let response;
    try {
      const signal = AbortSignal.timeout(90_000);
      for (let redirect = 0; redirect <= 4; redirect++) {
        response = await fetch(current, {
          ...options, signal, redirect: 'manual',
          headers: { 'User-Agent': 'AajKaSachNewsroom/1.0 (https://www.aajkasach.com)', ...options.headers },
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        assert(!options.method || options.method === 'GET', `${label}: refused write redirect`);
        assert(redirect < 4, `${label}: too many redirects`);
        current = safeUrl(new URL(response.headers.get('location'), current).href, domains);
      }
      const chunks = [];
      let size = 0;
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new Error('Response exceeds size limit');
      }
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        assert(size <= maxBytes, 'Response exceeds size limit');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (response.ok) return { bytes, type: response.headers.get('content-type') ?? '' };
      if (response.status === 429 && /perday|per_day|daily|limit[:"\s]+0/i.test(bytes.toString())) {
        throw new QuotaError(`${label}: daily quota exhausted or free-tier quota unavailable`);
      }
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const retryAfter = Number(response.headers.get('retry-after')) || 0;
        await sleep(Math.min(120_000, Math.max(retryAfter * 1000, 15_000 * 2 ** attempt)));
        continue;
      }
      throw new Error(`${label}: HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      if (error instanceof TypeError || error.name === 'TimeoutError') {
        if (attempt < retries) { await sleep(2000 * 2 ** attempt); continue; }
        throw new Error(`${label}: network failure or timeout`);
      }
      throw error;
    }
  }
}

export async function requestJson(url, options) {
  const result = await request(url, options);
  try { return JSON.parse(result.bytes.toString('utf8')); }
  catch { throw new Error(`${options.label}: invalid JSON response`); }
}

export function parseFeed(xml, now) {
  assert(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'Feed contains forbidden XML declarations');
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml);
  const entries = parsed.rss?.channel?.item ?? parsed.feed?.entry ?? [];
  return (Array.isArray(entries) ? entries : [entries]).flatMap((entry) => {
    try {
      const links = Array.isArray(entry.link) ? entry.link : [entry.link];
      const link = links.find((item) => typeof item === 'string' || !item?.['@_rel'] || item['@_rel'] === 'alternate');
      const url = canonicalSource(plainText(typeof link === 'string' ? link : link?.['@_href']));
      const published = new Date(entry.pubDate ?? entry.published ?? entry.updated);
      const age = now.getTime() - published.getTime();
      if (!Number.isFinite(age) || age < 0 || age > 48 * 60 * 60 * 1000) return [];
      const title = plainText(entry.title?.['#text'] ?? entry.title);
      if (!title) return [];
      return [{ id: hash(url), url, title, publishedAt: published.toISOString() }];
    } catch { return []; }
  });
}

export function extractArticle(html) {
  const page = load(html);
  page('script, style, nav, header, footer, aside, form, noscript, iframe').remove();
  const paragraphs = (scope) => normalize(scope.find('p').map((index, element) => page(element).text()).get().join(' '));
  const article = page('article').first();
  let text = paragraphs(article.length ? article : page('main').first());
  // Some publishers put the body outside <article>/<main>. Fall back to the whole
  // page only when the scoped container came up short, so this can never regress
  // a site that already parses cleanly.
  if (characterCount(text) < 1200) text = paragraphs(page('body'));
  assert(characterCount(text) >= 1200, 'Source has insufficient readable article text');
  return Array.from(text).slice(0, 7000).join('');
}

export async function collectSources(feedUrls, now, warnings, excluded = new Set()) {
  const candidates = new Map();
  for (const url of feedUrls) {
    try {
      const result = await request(url, { domains: SOURCE_DOMAINS, label: 'RSS feed', retries: 1 });
      for (const source of parseFeed(result.bytes.toString('utf8'), now)) {
        if (!excluded.has(source.id)) candidates.set(source.id, source);
      }
    } catch (error) { warnings.push(`Feed ${new URL(url).hostname}: ${error.message}`); }
  }
  const sources = [];
  for (const source of [...candidates.values()].sort((first, second) => second.publishedAt.localeCompare(first.publishedAt)).slice(0, 10)) {
    try {
      const result = await request(source.url, { domains: SOURCE_DOMAINS, label: 'Source article', retries: 0 });
      sources.push({ ...source, text: extractArticle(result.bytes.toString('utf8')) });
      if (sources.length === 6) break;
    } catch (error) { warnings.push(`Source ${source.id}: ${error.message}`); }
  }
  return sources;
}

export function validateArticles(payload, category, sources, alreadyUsed = new Set(), count = 2) {
  assert(CATEGORIES.includes(category), 'Invalid category');
  assert([1, 2].includes(count), 'Expected one or two articles per category');
  assert(Array.isArray(payload.articles) && payload.articles.length === count, `${category}: need exactly ${count} supported article(s)`);
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const used = new Set(alreadyUsed);
  const slugs = new Set();
  const titles = new Set();
  return payload.articles.map((article) => {
    assert(article && typeof article === 'object', `${category}: invalid article`);
    assert(!('author' in article) && !('reporter' in article), `${category}: bylines are forbidden`);
    assert(typeof article.title === 'string' && article.title.length >= 10 && article.title.length <= 220, `${category}: invalid headline`);
    assert(!titles.has(normalize(article.title)), `${category}: duplicate headline`);
    titles.add(normalize(article.title));
    assert(typeof article.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug) && article.slug.length <= 90 && !slugs.has(article.slug), `${category}: invalid or duplicate slug`);
    slugs.add(article.slug);
    assert(typeof article.district === 'string', `${category}: invalid district`);
    assert(Array.isArray(article.tags) && article.tags.length >= 3 && article.tags.length <= 6 && article.tags.every((tag) => typeof tag === 'string' && tag.trim()), `${category}: need 3-6 tags`);
    if (!Array.isArray(article.blocks) || article.blocks.length > 20) {
      throw new ArticleStructureError(`${category}: invalid blocks; expected an array of at most 20 block objects`);
    }
    for (const [index, block] of article.blocks.entries()) {
      const prefix = `${category}: invalid block at blocks[${index}]`;
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        throw new ArticleStructureError(`${prefix}; expected an object with type and text fields`);
      }
      if (!['paragraph', 'heading', 'bullet'].includes(block.type)) {
        throw new ArticleStructureError(`${prefix}; type is missing or unsupported; use exactly paragraph, heading, or bullet`);
      }
      if (typeof block.text !== 'string' || !block.text.trim()) {
        throw new ArticleStructureError(`${prefix}; text must be a non-empty string, not an array or nested object`);
      }
    }
    const paragraphs = article.blocks.filter((block) => block.type === 'paragraph').length;
    const headings = article.blocks.filter((block) => block.type === 'heading').length;
    if (!(paragraphs >= 4 && paragraphs <= 8 && headings >= 1 && headings <= 2 && article.blocks[0]?.type === 'paragraph')) {
      throw new ArticleStructureError(`${category}: incorrect article structure (paragraphs=${paragraphs}, headings=${headings}, firstBlock=${article.blocks[0]?.type ?? 'missing'}). Expected 4-8 paragraph blocks, 1-2 heading blocks, and a paragraph first.`);
    }
    const body = article.blocks.map((block) => block.text).join('\n');
    const bodyCharacters = characterCount(body);
    const totalCharacters = bodyCharacters + 1 + IMAGE_NOTICE_BUDGET;
    if (bodyCharacters < 1500 || totalCharacters > 2900) {
      throw new ArticleLengthError(`${category}: invalid article length (body=${bodyCharacters}, includingImageNotice=${totalCharacters} Unicode characters). Body must contain at least 1500 characters; body plus the reserved ${IMAGE_NOTICE_BUDGET}-character image credit must not exceed 2900. Revise toward 2000-2400 body characters using only supplied source facts.`);
    }
    const visible = [article.title, article.district, ...article.tags, body].join(' ');
    assert(!/[a-z]/i.test(visible) && /[\u0900-\u097f]/.test(visible), `${category}: article must use Devanagari, not Latin text`);
    assert(!/एजेंसी|हमारे संवाददाता|पीटीआई|एएनआई|अमर उजाला|दैनिक जागरण|दैनिक भास्कर|भास्कर|एबीपी|बीबीसी|एनडीटीवी/.test(visible), `${category}: outlet credit or byline in copy`);
    assert(Array.isArray(article.sourceIds) && article.sourceIds.length >= 1 && article.sourceIds.length <= 3 && new Set(article.sourceIds).size === article.sourceIds.length, `${category}: invalid source references`);
    assert(Array.isArray(article.evidence), `${category}: missing evidence`);
    for (const sourceId of article.sourceIds) {
      assert(sourceMap.has(sourceId) && !used.has(sourceId), `${category}: unknown or already used source`);
      const proof = article.evidence.find((item) => item.sourceId === sourceId);
      assert(proof && typeof proof.quote === 'string' && proof.quote.length >= 30 && proof.quote.length <= 180 && sourceMap.get(sourceId).text.includes(proof.quote), `${category}: evidence is not present verbatim in the source`);
      used.add(sourceId);
    }
    return {
      title: article.title, slug: article.slug, district: article.district, tags: article.tags,
      imageQueries: Array.isArray(article.imageQueries) ? [...new Set(article.imageQueries.filter((query) => typeof query === 'string' && /^[a-zA-Z][a-zA-Z -]{2,59}$/.test(query) && query.trim().split(/\s+/).length <= 3).map(normalize))].slice(0, 3) : [],
      blocks: article.blocks.map(({ type, text }) => ({ type, text })), category,
      sourceIds: article.sourceIds, evidence: article.evidence.filter((item) => article.sourceIds.includes(item.sourceId)).map(({ sourceId, quote }) => ({ sourceId, quote })),
      sources: article.sourceIds.map((sourceId) => {
        const { text: omitted, ...metadata } = sourceMap.get(sourceId);
        void omitted;
        return metadata;
      }),
    };
  });
}

// Licences we accept. CC0 and the public-domain mark need no credit; CC BY and
// CC BY-SA do, and that credit is rendered in the caption and the body notice.
const CC_GRANTS = [
  { pattern: /^\/publicdomain\/zero\/1\.0(?:\/|$)/, attribution: false },
  { pattern: /^\/publicdomain\/mark\/1\.0(?:\/|$)/, attribution: false },
  { pattern: /^\/licenses\/by\/(?:2\.0|2\.5|3\.0|4\.0)(?:\/|$)/, attribution: true },
  { pattern: /^\/licenses\/by-sa\/(?:2\.0|2\.5|3\.0|4\.0)(?:\/|$)/, attribution: true },
];

export function licenseGrant(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    if (url.hostname !== 'creativecommons.org' || url.username || url.password || url.port) return null;
    return CC_GRANTS.find((grant) => grant.pattern.test(url.pathname)) ?? null;
  } catch { return null; }
}

// Returns a grant descriptor ({ attribution }) for a usable file, otherwise null.
// NonCommercial and NoDerivatives deeds are absent from CC_GRANTS, so they are rejected.
export function eligibleImage(info) {
  const metadata = info.extmetadata ?? {};
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(info.mime) || !(info.width >= 800)) return null;
  if (!['', 'false', '0'].includes(plainText(metadata.NonFree?.value).toLowerCase())) return null;
  if (plainText(metadata.Restrictions?.value)) return null;
  const grant = licenseGrant(plainText(metadata.LicenseUrl?.value));
  if (grant) return grant;
  const publicDomain = plainText(metadata.LicenseShortName?.value) === 'Public domain'
    && plainText(metadata.Copyrighted?.value).toLowerCase() === 'false';
  return publicDomain ? { attribution: false } : null;
}

export function photoMatches(page, info, query) {
  const metadata = info.extmetadata ?? {};
  const description = plainText(metadata.ImageDescription?.value);
  const title = plainText(page.title).replace(/^File:/i, '').replace(/[_-]/g, ' ');
  const context = `${title} ${description} ${plainText(metadata.Categories?.value)}`;
  if (/watermark|ai[ -]generated|artificial intelligence|stable diffusion|midjourney|dall[ -]?e|computer[ -]generated|screenshot|\blogos?\b|\bdiagrams?\b|illustration|\bpaintings?\b|\bdrawings?\b|\bmaps?\b/i.test(context)) return false;
  const words = (value) => value.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  const terms = [...new Set(words(query))];
  // The file title alone is often terse, so the description counts as subject
  // evidence too, and half the query terms is enough to call it a match.
  const subjectTerms = new Set([...words(title), ...words(description)]);
  return terms.length > 0 && terms.filter((term) => subjectTerms.has(term)).length >= Math.max(1, Math.ceil(terms.length / 2));
}

export function imageContentType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Image has unsupported file signature');
}

const CREATOR_LIMIT = 60;

export function imageCredit(creator, license) {
  const name = normalize(creator) || 'अज्ञात';
  const clamped = characterCount(name) > CREATOR_LIMIT ? `${Array.from(name).slice(0, CREATOR_LIMIT - 1).join('')}…` : name;
  return `${clamped} / ${license || 'Creative Commons'}, विकिमीडिया कॉमन्स`;
}

export function imageNotice(image) {
  const base = 'चित्र: प्रतीकात्मक तस्वीर।';
  if (!image?.attribution) return base;
  const notice = `${base} साभार: ${image.attribution}`;
  return characterCount(notice) <= IMAGE_NOTICE_BUDGET ? notice : `${Array.from(notice).slice(0, IMAGE_NOTICE_BUDGET - 1).join('')}…`;
}

export async function findImage(query, fallbackQueries = []) {
  assert(typeof query === 'string' && query.trim().length >= 3 && query.length <= 120, 'Invalid image query');
  assert(Array.isArray(fallbackQueries) && fallbackQueries.length <= 2 && fallbackQueries.every((value) => typeof value === 'string' && value.trim().length >= 3 && value.length <= 120), 'Invalid image fallback queries');
  const queries = [...new Set([query, ...fallbackQueries].map(normalize))];
  let candidates = 0;
  for (const searchQuery of queries) {
    const url = new URL('https://commons.wikimedia.org/w/api.php');
    url.search = new URLSearchParams({
      action: 'query', format: 'json', generator: 'search', gsrsearch: `${searchQuery} filetype:bitmap`,
      gsrnamespace: '6', gsrlimit: '50', prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size', iiurlwidth: '1280',
    });
    const result = await requestJson(url, { domains: ['commons.wikimedia.org'], label: 'Commons search' });
    assert(!result.error, 'Commons search: API error; image search did not complete');
    const pages = Object.values(result.query?.pages ?? {}).sort((first, second) => first.index - second.index);
    candidates += pages.length;
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      const grant = eligibleImage(info);
      if (!grant || !photoMatches(page, info, searchQuery)) continue;
      const license = plainText(info.extmetadata?.LicenseShortName?.value);
      const creator = plainText(info.extmetadata?.Artist?.value);
      const attribution = grant.attribution ? imageCredit(creator, license) : '';
      const download = safeUrl(info.thumburl ?? info.url, IMAGE_DOMAINS).href;
      return {
        kind: 'real-photo', title: page.title, download, pageUrl: safeUrl(info.descriptionurl, ['commons.wikimedia.org']).href,
        license, creator, attribution,
        licenseUrl: plainText(info.extmetadata?.LicenseUrl?.value),
        caption: attribution ? `प्रतीकात्मक तस्वीर — ${attribution}` : 'प्रतीकात्मक तस्वीर',
        searchQuery,
      };
    }
  }
  throw new Error(`No reusable CC0/public-domain/CC BY/CC BY-SA image after ${queries.length} search(es), ${candidates} candidate(s); review or broaden the image queries`);
}

export function portableText(article) {
  return [...article.blocks, ...(article.image ? [{ type: 'paragraph', text: imageNotice(article.image) }] : [])].map((block, index) => ({
    _type: 'block', _key: `block-${index}`, style: block.type === 'heading' ? 'h3' : 'normal', markDefs: [],
    ...(block.type === 'bullet' ? { listItem: 'bullet', level: 1 } : {}),
    children: [{ _type: 'span', _key: `span-${index}`, marks: [], text: block.text }],
  }));
}

export function makeDocument(article, index, day, now, assetId, plan = batchPlan()) {
  const slot = index % plan.perCategory + 1;
  return {
    _id: `${plan.prefix}-${day}-${article.category}-${slot}`, _type: 'post',
    title: article.title, slug: { _type: 'slug', current: `${article.slug}-${article.sourceIds[0].slice(0, 8)}` },
    category: article.category, district: article.district, tags: article.tags, body: portableText(article),
    ...(article.image ? { mainImage: { _type: 'image', asset: { _type: 'reference', _ref: assetId }, alt: article.title, caption: article.image.caption } } : {}),
    editorialStatus: 'approved', webPriority: 60, isBreaking: false,
    publishedAt: new Date(now.getTime() - (plan.count - 1 - index) * 1000).toISOString(),
    newsroom: { day, batchSize: plan.count, sourceIds: article.sourceIds, sources: article.sources, evidence: article.evidence, image: article.image },
  };
}

export function verifyPosts(posts, day, plan = batchPlan()) {
  const expectedIds = new Set(postIds(day, plan));
  assert(posts.length === plan.count && new Set(posts.map((post) => post._id)).size === plan.count, `Expected ${plan.count} distinct batch post(s)`);
  const lengths = [];
  for (const category of plan.categories) assert(posts.filter((post) => post.category === category).length === plan.perCategory, `Expected ${plan.perCategory} post(s) in ${category}`);
  for (const post of posts) {
    assert(expectedIds.has(post._id), 'Unexpected batch post ID');
    assert(post.editorialStatus === 'approved', 'Missing approval');
    if (post.mainImage !== undefined) assert(post.mainImage?.asset?._ref, 'Malformed image reference');
    assert(!('author' in post) && !('reporter' in post), 'Unexpected byline');
    assert(post.webPriority === 60 && post.isBreaking === false, 'Unexpected homepage priority');
    assert(typeof post.title === 'string' && post.title && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug?.current ?? ''), 'Missing headline or invalid slug');
    const timestamp = Date.parse(post.publishedAt);
    assert(Number.isFinite(timestamp) && timestamp <= Date.now() && dayInIndia(new Date(timestamp)) === day, 'Invalid batch publication date');
    const body = (post.body ?? []).map((block) => (block.children ?? []).map((span) => span.text ?? '').join('')).join('\n');
    const length = characterCount(body);
    assert(length >= 1500 && length <= 2900, 'Invalid published body length');
    lengths.push(length);
  }
  assert(new Set(posts.map((post) => post.slug.current)).size === plan.count, 'Duplicate published slug');
  const withImages = posts.filter((post) => post.mainImage?.asset?._ref).length;
  return { count: posts.length, withImages, withoutImages: posts.length - withImages, approved: posts.length, bylines: 0, perCategory: Object.fromEntries(plan.categories.map((category) => [category, plan.perCategory])), bodyLength: { min: Math.min(...lengths), max: Math.max(...lengths), average: Math.round(lengths.reduce((sum, length) => sum + length, 0) / lengths.length) } };
}

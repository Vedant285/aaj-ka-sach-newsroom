import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';

export const CATEGORIES = ['up', 'uk', 'delhi', 'world', 'dharma', 'business', 'sports', 'others', 'mystery', 'lifestyle'];
const SOURCE_DOMAINS = ['amarujala.com', 'jagran.com', 'bbc.co.uk', 'bbci.co.uk', 'bbc.com', 'sciencedaily.com', 'nasa.gov'];
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
  const article = page('article').first();
  const container = article.length ? article : page('main').first();
  const text = normalize(container.find('p').map((index, element) => page(element).text()).get().join(' '));
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
    const totalCharacters = characterCount(`${body}\nचित्र: प्रतीकात्मक तस्वीर।`);
    if (bodyCharacters < 1500 || totalCharacters > 2900) {
      throw new ArticleLengthError(`${category}: invalid article length (body=${bodyCharacters}, includingImageNotice=${totalCharacters} Unicode characters). Body must contain at least 1500 characters; body including the image notice must not exceed 2900. Revise toward 2000-2400 body characters using only supplied source facts.`);
    }
    const visible = [article.title, article.district, ...article.tags, body].join(' ');
    assert(!/[a-z]/i.test(visible) && /[\u0900-\u097f]/.test(visible), `${category}: article must use Devanagari, not Latin text`);
    assert(!/एजेंसी|हमारे संवाददाता|पीटीआई|एएनआई|अमर उजाला|दैनिक जागरण|बीबीसी|एनडीटीवी/.test(visible), `${category}: outlet credit or byline in copy`);
    assert(Array.isArray(article.sourceIds) && article.sourceIds.length >= 1 && article.sourceIds.length <= 3 && new Set(article.sourceIds).size === article.sourceIds.length, `${category}: invalid source references`);
    assert(Array.isArray(article.evidence), `${category}: missing evidence`);
    for (const sourceId of article.sourceIds) {
      assert(sourceMap.has(sourceId) && !used.has(sourceId), `${category}: unknown or already used source`);
      const proof = article.evidence.find((item) => item.sourceId === sourceId);
      assert(proof && typeof proof.quote === 'string' && proof.quote.length >= 30 && proof.quote.length <= 180 && sourceMap.get(sourceId).text.includes(proof.quote), `${category}: evidence is not present verbatim in the source`);
      used.add(sourceId);
    }
    assert(typeof article.imageQuery === 'string' && article.imageQuery.length >= 3 && article.imageQuery.length <= 120, `${category}: invalid image query`);
    const imageFallbackQueries = article.imageFallbackQueries ?? [];
    assert(Array.isArray(imageFallbackQueries) && imageFallbackQueries.length <= 2 && imageFallbackQueries.every((query) => typeof query === 'string' && query.trim().length >= 3 && query.length <= 120), `${category}: invalid image fallback queries`);
    return {
      title: article.title, slug: article.slug, district: article.district, tags: article.tags,
      blocks: article.blocks.map(({ type, text }) => ({ type, text })), category,
      sourceIds: article.sourceIds, evidence: article.evidence.filter((item) => article.sourceIds.includes(item.sourceId)).map(({ sourceId, quote }) => ({ sourceId, quote })),
      imageQuery: article.imageQuery, imageFallbackQueries,
      sources: article.sourceIds.map((sourceId) => {
        const { text: omitted, ...metadata } = sourceMap.get(sourceId);
        void omitted;
        return metadata;
      }),
    };
  });
}

export function eligibleImage(info) {
  const metadata = info.extmetadata ?? {};
  const license = plainText(metadata.LicenseShortName?.value);
  return ['Public domain', 'CC0'].includes(license)
    && metadata.Copyrighted?.value === 'False'
    && metadata.AttributionRequired?.value !== 'True'
    && !plainText(metadata.Restrictions?.value)
    && ['image/jpeg', 'image/png', 'image/webp'].includes(info.mime)
    && info.width >= 800;
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
      if (!info || !eligibleImage(info)) continue;
      const download = safeUrl(info.thumburl ?? info.url, ['upload.wikimedia.org']).href;
      return {
        title: page.title, download, pageUrl: safeUrl(info.descriptionurl, ['commons.wikimedia.org']).href,
        license: plainText(info.extmetadata.LicenseShortName.value),
        creator: plainText(info.extmetadata.Artist?.value),
        licenseUrl: plainText(info.extmetadata.LicenseUrl?.value),
        caption: 'प्रतीकात्मक तस्वीर', searchQuery,
      };
    }
  }
  throw new Error(`No suitable CC0/public-domain image after ${queries.length} search(es), ${candidates} candidate(s); review or broaden the image queries`);
}

export function portableText(article) {
  return [...article.blocks, { type: 'paragraph', text: 'चित्र: प्रतीकात्मक तस्वीर।' }].map((block, index) => ({
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
    mainImage: { _type: 'image', asset: { _type: 'reference', _ref: assetId } },
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
    assert(post.mainImage?.asset?._ref && post.editorialStatus === 'approved', 'Missing image or approval');
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
  return { count: posts.length, withImages: posts.length, approved: posts.length, bylines: 0, perCategory: Object.fromEntries(plan.categories.map((category) => [category, plan.perCategory])), bodyLength: { min: Math.min(...lengths), max: Math.max(...lengths), average: Math.round(lengths.reduce((sum, length) => sum + length, 0) / lengths.length) } };
}

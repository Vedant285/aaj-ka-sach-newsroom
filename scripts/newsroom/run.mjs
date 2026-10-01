import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import {
  CATEGORIES, QuotaError, ArticleStructureError, ArticleLengthError, assert, batchPlan, collectSources, dayInIndia, makeDocument,
  IMAGE_DOMAINS, findImage, imageContentType, normalize, postIds, request, requestJson, validateArticles, verifyPosts,
} from './core.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

export function configuration(env = process.env) {
  const config = {
    key: env.GEMINI_API_KEY ?? '', model: env.GEMINI_MODEL ?? '',
    project: env.SANITY_PROJECT_ID || 'g1o8uwxq', dataset: env.SANITY_DATASET || 'production',
    token: env.SANITY_API_TOKEN ?? '', interval: Number(env.NEWSROOM_REQUEST_INTERVAL_MS || 15000),
    plan: batchPlan(Number(env.NEWSROOM_ARTICLE_COUNT || 1), env.NEWSROOM_CATEGORY || 'up'),
  };
  assert(/^[a-z0-9]+$/.test(config.project) && /^[a-zA-Z0-9_-]+$/.test(config.dataset), 'Invalid Sanity project or dataset');
  assert(Number.isFinite(config.interval) && config.interval >= 1000 && config.interval <= 120000, 'Request interval must be 1000-120000 milliseconds');
  return config;
}

function requireGemini(config) {
  assert(config.key && !config.key.startsWith('replace-'), 'Set GEMINI_API_KEY in .env.newsroom or GitHub Actions secrets');
  assert(/^[a-zA-Z0-9._-]+$/.test(config.model) && !config.model.startsWith('replace-'), 'Set GEMINI_MODEL to a free-tier model ID from AI Studio (without models/)');
}

export function sanityClient(config) {
  const host = `${config.project}.api.sanity.io`;
  const base = `https://${host}/v2021-06-07`;
  const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
  return {
    async query(query, params = {}) {
      const url = new URL(`${base}/data/query/${config.dataset}`);
      url.searchParams.set('query', query);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(`$${key}`, JSON.stringify(value));
      const result = await requestJson(url, { domains: [host], label: 'Sanity query', headers });
      assert(!result.error && result.result !== undefined, 'Sanity query failed');
      return result.result;
    },
    async upload(image, preparedBytes) {
      assert(config.token, 'Publishing requires SANITY_API_TOKEN');
      assert(image?.kind === 'real-photo' && Buffer.isBuffer(preparedBytes) && preparedBytes.length > 8 && preparedBytes.length <= 12_000_000, 'Missing or oversized prepared photo');
      assert(createHash('sha256').update(preparedBytes).digest('hex') === image.sha256, 'Photo integrity check failed');
      const type = imageContentType(preparedBytes);
      const result = await requestJson(`${base}/assets/images/${config.dataset}`, {
        domains: [host], label: 'Sanity asset upload', method: 'POST', retries: 0,
        headers: { ...headers, 'Content-Type': type }, body: preparedBytes,
      });
      assert(result.document?._id, 'Asset upload did not return an ID; inspect Sanity before retrying');
      return result.document._id;
    },
    async publish(documents) {
      assert(config.token, 'Publishing requires SANITY_API_TOKEN');
      await requestJson(`${base}/data/mutate/${config.dataset}?visibility=sync`, {
        domains: [host], label: 'Sanity publication transaction', method: 'POST', retries: 0,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutations: documents.map((document) => ({ createIfNotExists: document })) }),
      });
    },
  };
}

export async function generate(config, prompt, category, sources, alreadyUsed, count = 2, correctionRequest = null) {
  const response = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`, {
    domains: ['generativelanguage.googleapis.com'], label: 'Gemini generation', method: 'POST',
    headers: { 'x-goog-api-key': config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify({ category, requestedArticleCount: count, todayIST: dayInIndia(), sources, alreadyUsed, ...(correctionRequest ? { correctionRequest } : {}) }) }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: count === 1 ? 8000 : 14000 },
    }),
  });
  const candidate = response.candidates?.[0];
  assert(candidate?.finishReason === 'STOP', 'Gemini response blocked or truncated; nothing published');
  const text = (candidate.content?.parts ?? []).filter((part) => !part.thought).map((part) => part.text ?? '').join('');
  try { return JSON.parse(text); }
  catch { throw new Error('Gemini returned invalid JSON; nothing published'); }
}

async function verifyHomepage(client, posts) {
  let last = 'Homepage has not refreshed';
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await sleep(15000);
    try {
      const newest = await client.query('*[_type == "post" && (!defined(editorialStatus) || editorialStatus == "approved") && !(_id in path("drafts.**")) && defined(slug.current) && slug.current != "" && defined(title) && defined(publishedAt) && publishedAt <= now()] | order(publishedAt desc, _id asc)[0]{"slug":slug.current}');
      const result = await request('https://www.aajkasach.com', { domains: ['aajkasach.com', 'www.aajkasach.com'], label: 'Homepage', retries: 0 });
      const page = load(result.bytes.toString('utf8'));
      const lead = page('h1').first().closest('a').attr('href');
      const visible = posts.filter((post) => page(`a[href="/news/${post.slug.current}"]`).length > 0).length;
      assert(lead === `/news/${newest?.slug}` && visible >= Math.min(3, posts.length), `Homepage verification: newest lead=${lead === `/news/${newest?.slug}`}, batch links=${visible}`);
      return { lead, visibleBatchLinks: visible };
    } catch (error) { last = error.message; }
  }
  throw new Error(`${last}. Posts may already be live; do not delete or recreate them.`);
}

function reportMarkdown(report) {
  const safe = (value) => String(value).replace(/[\r\n|<>]/g, ' ');
  const lines = [
    '# Newsroom run', '', `Date (IST): ${report.day}`, `Mode: ${report.mode}`, `Requested articles: ${report.requestedCount}`, `Categories: ${report.categories.join(', ')}`, `Status: ${report.status}`, '',
    'Generated content and image relevance require editorial review. Automated checks do not establish factual accuracy.', '',
    '| Category | Headline | Published UTC | Image licence |', '| --- | --- | --- | --- |',
    ...report.articles.map((article) => `| ${safe(article.category)} | ${safe(article.title)} | ${safe(article.publishedAt ?? 'not published')} | ${safe(article.image?.license ?? article.newsroom?.image?.license ?? 'not resolved')} |`),
    '', '## Verification', '```json', JSON.stringify(report.verification ?? {}, null, 2), '```', '', '## Sources and images',
  ];
  for (const article of report.articles) {
    lines.push(`- ${safe(article.title)}`);
    for (const source of article.sources ?? article.newsroom?.sources ?? []) lines.push(`  - Source: ${safe(source.url)}`);
    const image = article.image ?? article.newsroom?.image;
    if (image) {
      lines.push(`  - Image: ${safe(image.pageUrl)}; ${safe(image.license)}; creator: ${safe(image.creator)}`);
      lines.push(image.attribution
        ? `  - Credit REQUIRED, published as: ${safe(image.attribution)}`
        : '  - No credit required (CC0 / public domain).');
      if (/^photo-[a-z]+-\d+\.(png|jpg|webp)$/.test(image.fileName ?? '')) lines.push('', `![Representative photo](./${image.fileName})`, '');
    } else lines.push('  - No image: article is ready for text-only publication.');
  }
  lines.push('', '## Warnings / failures', ...report.warnings.map((warning) => `- ${safe(warning)}`));
  if (report.error) lines.push(`- ${safe(report.error)}`);
  return `${lines.join('\n')}\n`;
}

export async function main(args = process.argv.slice(2)) {
  assert(args.length <= 1 && (!args.length || ['--help', '--check', '--dry-run', '--publish'].includes(args[0])), 'Use --check, --dry-run, or --publish');
  if (!args.length || args[0] === '--help') {
    console.log('Newsroom: --check (offline config check), --dry-run (no Sanity writes), --publish (live publication). Defaults to one article; see README.md.');
    return;
  }
  const config = configuration();
  const plan = config.plan;
  const mode = args[0] === '--publish' ? 'publish' : 'dry-run';
  const feeds = JSON.parse(await readFile(new URL('./feeds.json', import.meta.url), 'utf8'));
  assert(CATEGORIES.every((category) => Array.isArray(feeds[category]) && feeds[category].length), 'Feed configuration must cover all ten categories');
  requireGemini(config);
  if (args[0] === '--check') {
    console.log(`Offline configuration valid: ${plan.count} article(s), categories ${plan.categories.join(', ')}. Sanity publish token: ${config.token ? 'configured' : 'not configured (dry-run only)'}. Credentials and quotas were NOT tested.`);
    return;
  }
  if (mode === 'publish') assert(config.token, 'Set SANITY_API_TOKEN before publishing');
  const now = new Date();
  const day = dayInIndia(now);
  const output = resolve(ROOT, 'newsroom-output', `${day}-${mode}-${Date.now()}`);
  await mkdir(output, { recursive: true });
  const report = { day, mode, requestedCount: plan.count, categories: plan.categories, status: 'started', articles: [], warnings: [], verification: {} };
  const client = sanityClient(config);
  const preparedImages = new Map();
  const ids = postIds(day, plan);
  const getBatch = () => client.query('*[_id in $ids]', { ids });
  const writeReport = async () => {
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(resolve(output, 'report.md'), reportMarkdown(report));
  };
  try {
    const existing = await getBatch();
    if (existing.length) {
      report.articles = existing;
      report.verification = verifyPosts(existing, day, plan);
      report.status = 'already-published';
      if (mode === 'publish') report.verification.homepage = await verifyHomepage(client, existing);
      console.log('This IST day already has a complete batch. No generation or writes performed.');
      return;
    }
    const recent = await client.query('*[_type == "post" && publishedAt >= $since && !(_id in path("drafts.**"))]{title,"sourceIds":newsroom.sourceIds}', { since: new Date(now.getTime() - 72 * 3600000).toISOString() });
    const used = new Set(recent.flatMap((post) => post.sourceIds ?? []));
    const prompt = await readFile(new URL('./editorial-prompt.md', import.meta.url), 'utf8');
    const pools = {};
    const feedCategories = [...new Set([...plan.categories, 'others'])];
    for (const category of feedCategories) {
      console.log(`Collecting sources: ${category}`);
      pools[category] = await collectSources(feeds[category], now, report.warnings, used);
    }
    let lastRequest = 0;
    const alreadyUsed = recent.map((post) => post.title).slice(0, 100);
    for (const category of plan.categories) {
      try {
        const local = pools[category].filter((source) => !used.has(source.id));
        const fallback = [...(pools.others ?? []), ...(pools.world ?? []), ...(pools.mystery ?? [])].filter((source) => !used.has(source.id));
        const sources = [...new Map([...local, ...fallback].map((source) => [source.id, source])).values()].slice(0, 8);
        assert(sources.length >= plan.perCategory, `${category}: insufficient recent, readable sources`);
        console.log(`Generating and validating: ${category}`);
        let articles;
        let correctionRequest = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          await sleep(Math.max(0, config.interval - (Date.now() - lastRequest)));
          lastRequest = Date.now();
          const payload = await generate(config, prompt, category, sources, alreadyUsed, plan.perCategory, correctionRequest);
          if (Array.isArray(payload.skipped) && payload.skipped.length) report.warnings.push(`${category}: model reported ${payload.skipped.length} skipped items`);
          try {
            articles = validateArticles(payload, category, sources, used, plan.perCategory);
            break;
          } catch (error) {
            if (!(error instanceof ArticleStructureError || error instanceof ArticleLengthError) || attempt === 1 || JSON.stringify(payload).length > 40000) throw error;
            const warning = `${error.message} Requesting one format/length correction; this consumes another Gemini request.`;
            report.warnings.push(warning);
            console.warn(warning);
            correctionRequest = { validationError: error.message, previousResponse: payload };
            await writeReport();
          }
        }
        assert(articles, `${category}: article validation did not complete`);
        const priorTitles = new Set(alreadyUsed.filter((title) => typeof title === 'string').map(normalize));
        assert(articles.every((article) => !priorTitles.has(normalize(article.title))), `${category}: headline duplicates another generated or recent article`);
        for (const article of articles) {
          article.sourceIds.forEach((sourceId) => used.add(sourceId));
          alreadyUsed.push(article.title);
          report.articles.push(article);
          article.image = null;
          try {
            assert(article.imageQueries.length, 'No usable photo search terms');
            const image = await findImage(article.imageQueries[0], article.imageQueries.slice(1));
            const downloaded = await request(image.download, { domains: IMAGE_DOMAINS, label: 'Photo download', maxBytes: 12_000_000, retries: 0 });
            const type = imageContentType(downloaded.bytes);
            assert(downloaded.type.split(';')[0] === type, 'Photo content type does not match its bytes');
            const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type];
            const fileName = `photo-${article.category}-${report.articles.length}.${extension}`;
            await writeFile(resolve(output, fileName), downloaded.bytes);
            preparedImages.set(fileName, downloaded.bytes);
            article.image = { ...image, fileName, sha256: createHash('sha256').update(downloaded.bytes).digest('hex') };
          } catch (error) {
            const warning = `${category}: no image; continuing text-only. ${error.message}`;
            report.warnings.push(warning);
            console.warn(warning);
          }
        }
      } catch (error) {
        const warning = error.message.startsWith(`${category}:`) ? error.message : `${category}: ${error.message}`;
        report.warnings.push(warning);
        console.warn(warning);
        if (error instanceof QuotaError || error.message.startsWith('Gemini generation:')) throw error;
      }
      await writeReport();
    }
    assert(report.articles.length === plan.count, `Batch incomplete: need ${plan.count} validated article(s). No posts published. See report.`);
    const documents = report.articles.map((article, index) => makeDocument(article, index, day, now, 'dry-run-placeholder', plan));
    report.verification = verifyPosts(documents, day, plan);
    await writeFile(resolve(output, 'documents.json'), JSON.stringify(documents, null, 2));
    if (mode === 'dry-run') {
      report.status = 'dry-run-ready-for-review';
      console.log('Dry-run complete. No Sanity assets or posts were written.');
      return;
    }
    assert(dayInIndia() === day, 'IST date changed during the run; refusing publication');
    assert((await getBatch()).length === 0, 'Another publisher created this batch; rerun to verify instead');
    const slugConflicts = await client.query('*[_type == "post" && slug.current in $slugs]{_id}', { slugs: documents.map((document) => document.slug.current) });
    assert(slugConflicts.length === 0, 'An article slug already exists; inspect the conflict before publishing');
    for (let index = 0; index < documents.length; index++) {
      const image = report.articles[index].image;
      if (!image) continue;
      documents[index].mainImage.asset._ref = await client.upload(image, preparedImages.get(image.fileName));
      await writeFile(resolve(output, 'documents.json'), JSON.stringify(documents, null, 2));
    }
    assert(dayInIndia() === day, 'IST date changed during uploads; refusing publication');
    try { await client.publish(documents); }
    catch (error) { report.warnings.push(`${error.message}; checking the effect without retrying the write`); }
    let published = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(2000);
      published = await getBatch();
      if (published.length === plan.count) break;
    }
    report.verification = verifyPosts(published, day, plan);
    report.articles = published;
    report.status = 'published';
    await writeReport();
    report.verification.homepage = await verifyHomepage(client, published);
    console.log(`Published and verified ${plan.count} article(s).`);
  } catch (error) {
    report.status = report.status === 'published' || report.status === 'already-published' ? 'published-verification-failed' : 'failed';
    report.error = error.message;
    throw error;
  } finally {
    await writeReport();
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, reportMarkdown(report));
    console.log(`Report saved: ${output}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const secrets = [process.env.GEMINI_API_KEY, process.env.SANITY_API_TOKEN].filter(Boolean);
    let message = error.message;
    for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
    console.error(message);
    process.exitCode = 1;
  });
}

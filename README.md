# Aaj Ka Sach - standalone newsroom automation

This folder is a complete, independent GitHub Actions project. You do **not** need
to upload the website, Next.js app, Sanity Studio, old newsroom batches, images, or
local environment files. It talks to Gemini and Sanity over their APIs.

Manual runs default to **one article + dry-run**. No schedule is enabled
automatically, and the newsroom never publishes anything itself: every article it
writes is a Sanity draft that stays off the website until an editor approves it
(see [Approving articles](#approving-articles)). The original website folder has not
been changed by this standalone extraction. Use this repository as your automation
source going forward.

## Create your separate GitHub repository

1. Create a new repository, for example `aaj-ka-sach-newsroom`. Private is a sensible
   choice for unpublished editorial working material; check your Actions allowance.
2. Upload the **contents of this folder to the repository root**, preserving paths.
   You can use GitHub's **Add file > Upload files** screen and drag in the files and
   folders. For an empty repository, use its **uploading an existing file** link.
3. Include `.github` and `.gitignore`; do not omit dot-prefixed names.
4. Commit the upload to your default branch (usually `main`). This guide does not
   create a repository, commit, or push anything on your behalf.
5. Check that the workflow is at `.github/workflows/newsroom.yml`, **not** at
   `aaj-ka-sach-newsroom/.github/workflows/newsroom.yml` inside an extra outer folder.

The upload contains these files only:

```text
.github/
  workflows/
    newsroom.yml
.gitignore
README.md
package.json
scripts/
  newsroom/
    core.mjs
    run.mjs
    editorial-prompt.md
    env.example
    feeds.json
    package.json
    package-lock.json
```

If you later install dependencies or run locally, do not upload `node_modules`,
`newsroom-output`, or `.env.newsroom`. Git ignores these, but manually uploading
files through a browser should not be treated as a substitute for checking them.

## Add the key and settings to THIS repository

Open **Settings > Secrets and variables > Actions** in the new automation repo.
Settings in your website repository are not automatically copied here.

Under **Secrets > New repository secret**:

| Name | Value |
| --- | --- |
| `GEMINI_API_KEY` | Your private Gemini API key from Google AI Studio |

Under **Variables > New repository variable**:

| Name | Value |
| --- | --- |
| `GEMINI_MODEL` | Exact supported free-tier text model ID from your AI Studio project, without `models/` |
| `SANITY_PROJECT_ID` | `g1o8uwxq` |
| `SANITY_DATASET` | `production` |
| `NEWSROOM_ENABLED` | `true` |
| `NEWSROOM_PUBLISH` | `true` |
| `NEWSROOM_REQUEST_INTERVAL_MS` | `15000` (optional) |

No Sanity write token is needed for your first preview. The production dataset is
expected to allow public reads for duplicate checks. A private dataset requires a
separate read-token configuration; the dry-run workflow does not receive the write token.

Use a Gemini text model supporting `generateContent` and JSON responses. Check its
actual free-tier request and token quotas in AI Studio. The example environment file
contains placeholders, not a working key or model. Never post your key in chat,
issues, screenshots, or source code, and never prefix it with `NEXT_PUBLIC_`.

## First run: write ONE article, publish NOTHING

1. Open **Actions > Daily Hindi newsroom > Run workflow**.
2. Select these inputs:

   | Input | Choose |
   | --- | --- |
   | Branch | Your default branch, usually `main` |
   | mode | `dry-run` |
   | article_count | `1` |
   | category | `up`, or your preferred category |

3. Click **Run workflow** and open that run to watch progress.
4. Read the summary after completion. Download the `newsroom-...` artifact under
   **Artifacts** on the run summary page.
5. Open `report.json` for the full generated article, source references and evidence.
   `report.md` has the headline, checks, and warnings. `documents.json` contains
   proposed Sanity documents, not ready-to-import files.

The one-article run generates only the selected category and normally makes one
Gemini generation request. It may retry transient API errors, so it is not a promise
of exactly one billable/quota-counted request. It also fetches source articles.
Dry-run consumes API quota but creates no posts. If no suitable supported story
exists, it fails rather than inventing one.

## Text only, no photos

Articles are text only. The newsroom does not search for, download or upload a
photo, and posts are created without `mainImage`. Photos matched to a story by
keyword were too often of the wrong subject, so photo selection was removed. It
never calls an AI image API, renders headline cards, or adds a title/date/branding
overlay. Content, source, date and duplication checks still apply.

Dry-run makes no Sanity writes. Publish mode generates fresh articles and writes
them as drafts; it does not promote an older reviewed artifact. Posts already
written that IST day are never modified.

No new secret, paid API or workflow edit is required. Old headline-card/font files
can remain; the runner no longer imports or uses them.

If the response has malformed block objects, the wrong paragraph/subheading
structure, or an out-of-range body length, the runner prints the offending block
requirement or actual counts and allows **one format/length correction request per
category in total**, not one per error type. Length diagnostics count Unicode
characters. The body needs 1,500-2,900 characters; nothing is appended to it. This
correction consumes additional Gemini quota and uses the same request pacing. The
corrected article must pass every original validation rule. It does not retry
missing-story, evidence, or other validation failures as format/length corrections.
Any remaining validation failure stops that category; the runner never loops indefinitely.
The final category failure is printed in the Actions log as well as the report.

After uploading code fixes to GitHub, start a **new run** using **Actions > Daily
Hindi newsroom > Run workflow** on `main`. Do not use **Re-run jobs** on an old run
to test new code, since that repeats the old run's commit.

Categories: `up` (Uttar Pradesh), `uk` (Uttarakhand), `delhi`, `world`, `dharma`,
`business`, `sports`, `others`, `lifestyle`. National/international fallback
sources may be used when appropriate local coverage is unavailable.

## If Gemini fails: run the connection check

The independent [Gemini API check workflow](./.github/workflows/gemini-check.yml)
sends at most one small JSON request using the same repository secret and model
variable. It never fetches news, touches Sanity, retries, or prints the API key.
This request can consume Gemini quota; a successful result does not guarantee
that a much larger news request will succeed or fit free-tier limits.

If your repository already has the original upload, add just this new workflow
file to `.github/workflows/gemini-check.yml` on your default branch. You do not need
to replace the existing newsroom workflow or upload the whole project again.

Open **Actions > Gemini API check > Run workflow**. After completion, open the
run summary or **Check Gemini with one small request** log. Share the diagnostic
`httpStatus`, `apiStatus`, `message`, and `finishReason` if present. The message is
bounded and the configured key is redacted; raw API bodies are not printed.

- **Passed:** retry a one-article dry-run.
- **503:** the small request is also unavailable; examine the API message, wait,
  or test another model after confirming its free-tier access in your project.
- **429:** inspect the project's actual model quota instead of repeatedly rerunning.
- **400/401/403/404:** read the API message for key, restrictions, model, or request
  compatibility issues. A status alone does not identify every possible cause.
- **HTTP 200 but failed:** the service responded but did not complete valid JSON;
  inspect `finishReason` before attributing it to service overload.

## Later: write one article for approval

Only after reviewing the preview and accepting automated generation:

1. Create a dedicated Sanity project API token with the minimum permissions available
   for writing posts. Do not reuse a personal CLI session token.
2. Add it to this repository's **Secrets** as `SANITY_API_TOKEN`.
3. Run the same workflow with `mode=publish`, `article_count=1`, and your category.

**Publish mode writes to Sanity, but it does not put anything on the website.** Each
article is saved as an unpublished draft with editorial status **⏳ In review —
waiting for the desk**, and readers see it only after an editor approves it (see
[Approving articles](#approving-articles)). Publish mode generates a fresh article;
it does not promote the exact article from a previous dry-run.

One-article runs use IDs such as `drafts.newsroom-test-YYYY-MM-DD-up-1`. Each IST
day/category has one such slot: once it is written, reruns report on it rather than
creating another. These IDs do not collide with the normal daily 18-article batch.
Recent source URLs and exact headlines, including those of drafts still waiting for
approval, are also checked, but semantic duplicates are not guaranteed to be detected.

The `NEWSROOM_ENABLED` and `NEWSROOM_PUBLISH` variables control scheduled runs only;
they do **not** override a manually selected publish mode. Restrict repository write
access to trusted collaborators. GitHub concurrency is scoped to a repository:
disable the old website repository's newsroom schedule if it was ever enabled.
Do not run both repositories or local and GitHub publishers at the same time.

## Approving articles

Approve posts in the Studio built into the website, at `/studio` on the site's own
address. The separately hosted `aapkasach.sanity.studio` still runs an old schema;
do not use it for approvals.

1. Open **🗞️ Newsroom > ⏳ Awaiting review**. Newsroom drafts are listed there.
2. Open a post and check its facts, headline and category. The run's `report.md`
   lists each article's source links. Edit anything that needs it; you can also add
   a photo.
3. Set **Editorial status** to **✅ Approved — live on the website**. This needs an
   administrator, editor or developer account.
4. Click **Publish**.

The website shows only approved posts. If you click **Publish** without step 3, the
post stays hidden and remains under **⏳ Awaiting review**: set the status and
publish again.

To reject a story, set its status to **🗄️ Archived — pulled from the website**, or
delete it.

Worth knowing:

- **Published at** is when the newsroom wrote the draft, not when it was approved.
  The homepage is ordered by this date, so update it when approving late if the
  story should appear as new.
- Drafts in review and archived ones count as recent posts: for 14 days the
  newsroom will not reuse their sources or headlines. Deleting a draft frees them,
  so the same story may be written again while it is still in the news feeds;
  archive it instead to keep it out.
- Once a day's batch is written, later runs that day only report how many of its
  posts are published and how many are still drafts. They do not replace rejected
  stories or top the batch up. If every post of the day is deleted, a new run
  writes a fresh batch.
- A dry-run has no Sanity token and cannot see drafts, so it may pick stories
  already waiting for approval. It still writes nothing.

## Later: the full daily batch

For a manual full run, select `article_count=18` (the script accepts only 1 or 18).
The category dropdown is ignored: the script asks for two articles in each of the
nine categories. Articles that still fail validation after their one correction are
dropped, so a batch can be smaller than 18; it is written as long as at least one
article passes.

Scheduled runs are always the full batch, at the time set by the `cron` line in
`.github/workflows/newsroom.yml` (GitHub reads it as UTC; India is UTC+5:30):

- `NEWSROOM_ENABLED=false`: no scheduled processing (initial setting).
- `NEWSROOM_ENABLED=true`, `NEWSROOM_PUBLISH=false`: daily dry-run only.
- Both `true`: the day's articles are written to Sanity as drafts awaiting approval.
  Nothing reaches the website until an editor approves each one.

GitHub's schedule may be delayed and public-repository inactivity can disable it.
Free Gemini quota does not guarantee capacity for 18 long articles/day. GitHub
Actions usage allowances are separate from API quotas. Your Windows computer does
not need to stay on: the workflow uses a GitHub-hosted Ubuntu runner.

## Optional Windows PowerShell usage

You do not need to install anything locally to use the GitHub workflow. To run on
Windows, install Node.js 24 (minimum 22.12) and open PowerShell in this folder:

```powershell
npm.cmd run newsroom:install
Copy-Item scripts/newsroom/env.example .env.newsroom
notepad .env.newsroom
```

Fill in the key and model. Keep `NEWSROOM_ARTICLE_COUNT=1` and choose a
`NEWSROOM_CATEGORY`. Do not overwrite an existing environment file on later setup runs.

```powershell
npm.cmd run newsroom:check
npm.cmd run newsroom:dry-run
```

The configuration check is offline; it does not verify credentials, quotas, or API
availability. Local output is saved under `newsroom-output`. An explicitly requested
`npm.cmd run newsroom:publish` writes drafts awaiting approval, using the configured
count/category. Using `npm.cmd` avoids PowerShell execution-policy issues with `npm.ps1`.

## Safeguards and limitations

- Fresh, dated RSS entries and extracted article text are supplied to Gemini.
  Sources are untrusted data, not instructions. No shell tools or search-grounding
  tools are exposed to the model; endpoint and source hosts are allowlisted.
- Validate article counts, Hindi text, paragraph/subhead structure, body length,
  slugs/tags, source references, and exact evidence excerpts. Evidence proves text
  was supplied, not that every generated claim is correct. Review factual accuracy,
  positivity and originality yourself.
- Text only: no photo is searched for, downloaded or uploaded, and no AI image or
  headline card is generated in its place.
- Never publish. The runner writes only `drafts.` documents with status `in-review`
  and refuses any other ID. It cannot change or publish an existing post; an editor
  approves each article in the Studio.
- Every category is generated and validated before anything is written to Sanity.
  A single transaction uses `createIfNotExists`; uncertain writes are checked by
  reading the drafts back rather than blindly retried. A failed write cannot leave
  a partial batch.
- Existing daily IDs, source reuse, headline duplicates, dates, bylines, priority
  and counts are checked, and the written drafts are verified. The website is not
  checked: nothing appears there until an editor approves it.
- No global unpinning, website builds/deployments, git commits/pushes, or original
  PowerShell prompt execution. This project does not contain the website's code.
- Reports are retained in GitHub for seven days. No full source-page HTML, API keys,
  or complete Gemini HTTP responses are saved. Treat reports as editorial working material.

The [feed list](./scripts/newsroom/feeds.json),
[editorial instructions](./scripts/newsroom/editorial-prompt.md), and
[workflow](./.github/workflows/newsroom.yml) are editable. If you add a feed on a new
host, add its trusted domain to `SOURCE_DOMAINS` in [core.mjs](./scripts/newsroom/core.mjs).
Unsupported, blocked, stale, or short sources are skipped with diagnostics.

Official references: [GitHub file uploads](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository),
[manual workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow),
[Gemini API](https://ai.google.dev/api/generate-content), and
[Gemini quotas](https://ai.google.dev/gemini-api/docs/rate-limits).

import type { ApplicationDraftResult, ApplicationList, ApplicationPreview, ApplicationSubmitResult } from '../core/apply.ts';
import type { CvDraftResult, CvList, CvSubmitResult, ImportResult, RenderResult } from '../core/cv.ts';
import type { DoctorReport } from '../core/doctor.ts';
import type { Draft } from '../core/drafts.ts';
import type { InboxList, InboxThread, MarkUnreadResult } from '../core/inbox.ts';
import { profileFieldText, type DiffLine, type ProfileDraftResult, type ProfileKey, type ProfileSubmitResult } from '../core/profile.ts';
import type {
  CompanySubscriptionDraftResult,
  SubscriptionDraftResult,
  SubscriptionOptions,
  SubscriptionPreview,
  SubscriptionSubmitResult,
} from '../core/subscriptions.ts';
import type { WatchCheck, Watch } from '../core/watches.ts';
import { table } from './command.ts';
import type { ProfilePage } from '../parsers/profile.ts';
import type { CandidateDetail, CandidateList, CandidateSummary } from '../parsers/candidates.ts';
import type { ApplicantStats, JobDetail, JobsPage, JobSummary, SimilarJob } from '../parsers/jobs.ts';
import { BIN } from '../bin.ts';

// The human text of the CLI. Each function returns full lines.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lines = (items: (string | null | undefined | false)[]) => `${items.filter(l => l !== null && l !== undefined && l !== false).join('\n')}\n`;

export function salaryText(salary: JobSummary['salary']): string {
  if (!salary || (salary.min === null && salary.max === null)) return 'salary hidden';
  if (salary.min !== null && salary.max !== null) return salary.min === salary.max ? `$${salary.min}` : `$${salary.min}-${salary.max}`;
  return salary.min !== null ? `from $${salary.min}` : `up to $${salary.max}`;
}

export const jobLine = (job: JobSummary) =>
  `${job.id}  ${job.title} | ${job.company} | ${salaryText(job.salary)} | ${plural(job.applications, 'applicant')} | ${job.url}`;

// "hiddenOmitted" is the number of hidden jobs that the page does not show. The next offset counts them too.
export function jobsPageText(page: JobsPage & { hiddenOmitted?: number }): string {
  const hidden = page.hiddenOmitted ?? 0;
  const hiddenLine = hidden > 0 && `${plural(hidden, 'hidden job')} not shown.`;
  const next = page.offset + page.jobs.length + hidden;
  if (page.jobs.length === 0) return lines([`${plural(page.count, 'job')}. This page has no jobs.`, hiddenLine]);
  return lines([
    `${plural(page.count, 'job')}. Jobs ${page.offset + 1}-${page.offset + page.jobs.length}:`,
    ...page.jobs.map(jobLine),
    hiddenLine,
    page.hasNextPage && `More jobs: add --offset ${next}.`,
  ]);
}

const field = (label: string, value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? null : `${label}: ${value}`;

export function jobText(job: JobDetail): string {
  const recruiter = job.recruiter && [job.recruiter.name, job.recruiter.position, job.recruiter.url].filter(Boolean).join(', ');
  return lines([
    job.title,
    `${job.company} | ${salaryText(job.salary)} | ${job.url}`,
    '',
    field('Category', job.category),
    field('Location', job.location),
    field('Work format', job.workFormat),
    field('Experience', job.experienceYears === null ? null : plural(job.experienceYears, 'year')),
    field('English', job.english),
    field('Domain', job.domain),
    field('Published', job.published),
    field('Views', job.views),
    field('Applicants', job.applications),
    `Applied: ${job.hasApplied ? 'yes' : 'no'}`,
    field('Skills', job.skills.map(s => (s.years === null ? s.name : `${s.name} (${plural(s.years, 'year')})`)).join(', ')),
    field('Languages', job.languages.map(l => `${l.language} (${l.level})`).join(', ')),
    field('Recruiter', recruiter),
    '',
    job.description,
  ]);
}

export function statsText(stats: ApplicantStats & { note?: string }): string {
  if (stats.note) return lines([stats.note]);
  return lines([
    `Top skills: ${stats.topSkills.join(', ') || 'none'}`,
    ...stats.distributions.flatMap(d => [
      `${d.title || d.key}:`,
      ...d.buckets.map(b => `  ${b.label}: ${b.count} (${b.percent}%)${b.you ? ' <- you' : ''}`),
    ]),
  ]);
}

export const similarText = (jobs: SimilarJob[]) =>
  jobs.length === 0
    ? lines(['djinni shows no similar jobs.'])
    : lines(jobs.map(j => `${j.id}  ${j.title} | ${j.company} | ${j.salaryLevel ?? 'salary level hidden'} | ${j.url}`));

type CompanyResult = {
  name: string;
  url: string;
  description: string | null;
  facts: Record<string, string>;
  links: { label: string; url: string }[];
  hasMoreJobs: boolean;
  jobs: JobSummary[];
};

export function companyText(company: CompanyResult): string {
  return lines([
    company.name,
    company.url,
    '',
    ...Object.entries(company.facts).map(([k, v]) => `${k}: ${v}`),
    ...company.links.map(l => `${l.label}: ${l.url}`),
    company.description !== null && '',
    company.description,
    '',
    company.jobs.length ? 'Open jobs:' : 'No open jobs on the first page of the search.',
    ...company.jobs.map(jobLine),
    company.hasMoreJobs && `More jobs: ${BIN} jobs search --company "${company.name}"`,
  ]);
}

const filtersText = (filters: Watch['filters']) => {
  const parts = Object.entries(filters).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`);
  return parts.length ? parts.join(' ') : 'no filters';
};

export const watchesText = (watches: Watch[]) =>
  watches.length === 0
    ? lines([`No watches. Add one with: ${BIN} watch add <name> [filter flags]`])
    : lines(watches.map(w => `${w.id}  ${w.name} | ${filtersText(w.filters)} | last check: ${w.lastCheckedAt ?? 'never'}`));

export function watchChecksText(results: WatchCheck[]): string {
  if (results.length === 0) return lines([`No watches. Add one with: ${BIN} watch add <name> [filter flags]`]);
  return lines(
    results.flatMap(r => {
      const head = `${r.watch.name} (${r.watch.id})`;
      if ('error' in r) return [`${head}: the check failed: ${r.error}`];
      if (r.newJobs.length === 0) return [`${head}: no new jobs.`];
      const title = r.firstCheck
        ? `${head}: ${plural(r.newJobs.length, 'job')}. This is the first check, so the list has the newest jobs, not only new jobs.`
        : `${head}: ${plural(r.newJobs.length, 'new job')}.`;
      return [title, ...r.newJobs.map(j => `  ${jobLine(j)}`)];
    }),
  );
}

const candidateSalary = (c: { salary: string | null; salaryType: string | null }) =>
  [c.salary, c.salaryType].filter(Boolean).join(' ') || 'salary hidden';

export const candidateLine = (c: CandidateSummary) =>
  `${c.hash}  ${c.title} | ${candidateSalary(c)} | ${c.experience ?? 'experience hidden'} | ${c.url}`;

export function candidateListText(page: CandidateList): string {
  const count = page.totalText ? ` The search has ${page.totalText} candidates.` : '';
  if (page.candidates.length === 0) return lines([`Page ${page.page} has no candidates.${count}`]);
  return lines([
    `Page ${page.page}.${count}`,
    ...page.candidates.map(candidateLine),
    page.hasNextPage && `More candidates: add --page ${page.page + 1}.`,
  ]);
}

export const similarCandidatesText = (candidates: CandidateSummary[]) =>
  candidates.length === 0 ? lines(['djinni shows no similar candidates.']) : lines(candidates.map(candidateLine));

const named = (items: { name: string; value: string | null }[]) => items.map(i => (i.value ? `${i.name} (${i.value})` : i.name)).join(', ');

export function candidateText(c: CandidateDetail): string {
  const sections: [string, string | null][] = [
    ['Work experience', c.workExperience],
    ['Achievements', c.achievements],
    ['Job expectations', c.jobExpectations],
    ...Object.entries(c.otherSections),
  ];
  return lines([
    c.title,
    `${c.hash} | ${candidateSalary(c)} | ${c.url}`,
    '',
    field('Category', c.category),
    field('Location', c.location),
    field('Experience', c.experience),
    field('English', c.english),
    field('Employment', c.employment.join(', ')),
    field('Work format', c.format),
    field('Published', c.published),
    field('Skills', named(c.skills.map(s => ({ name: s.skill, value: s.years })))),
    field('Domains', named(c.domains.map(s => ({ name: s.domain, value: s.years })))),
    field('Languages', named(c.languages.map(l => ({ name: l.language, value: l.level || null })))),
    field('Certifications', c.certifications.join(', ')),
    field('Communication language', c.communicationLanguage),
    ...sections.flatMap(([title, text]) => (text ? ['', `${title}:`, text] : [])),
  ]);
}

const PROFILE_LINES: [ProfileKey, string][] = [
  ['category', 'Category'],
  ['salaryMin', 'Salary'],
  ['salaryHour', 'Hourly rate'],
  ['salaryType', 'Salary type'],
  ['experienceYears', 'Experience'],
  ['skills', 'Skills'],
  ['languages', 'Languages'],
  ['domains', 'Domains'],
  ['certifications', 'Certifications'],
  ['country', 'Country'],
  ['location', 'Location'],
  ['formats', 'Work formats'],
  ['employment', 'Employment'],
  ['domainZones', 'Unwanted domains'],
  ['uninterestedCompanyTypes', 'Unwanted company types'],
  ['communicationLanguages', 'Communication languages'],
  ['preferredCommunication', 'Preferred contact'],
  ['isDefender', 'Defender'],
  ['hasMobilizationDeferment', 'Mobilization deferment'],
];

const PROFILE_SECTIONS: [ProfileKey, string][] = [
  ['workExperience', 'Work experience'],
  ['achievements', 'Achievements'],
  ['expectations', 'Job expectations'],
];

export function profileText(page: ProfilePage): string {
  return lines([
    page.position,
    '',
    ...PROFILE_LINES.map(([key, label]) => `${label}: ${profileFieldText(page, key)}`),
    ...PROFILE_SECTIONS.flatMap(([key, label]) => ['', `${label}:`, profileFieldText(page, key)]),
  ]);
}

// The next lines of a multiline value get the indent of the first line.
const indented = (prefix: string, text: string) => prefix + text.split('\n').join(`\n${' '.repeat(prefix.length)}`);

export const diffText = (diff: DiffLine[]) => lines(diff.flatMap(d => [`${d.field}:`, indented('  - ', d.old), indented('  + ', d.new)]));

export const profileDraftText = (draft: ProfileDraftResult) =>
  diffText(draft.diff) +
  lines(['', `Draft ${draft.draftId} expires at ${draft.expiresAt}. Nothing was sent to djinni.`, `Send it with: ${BIN} profile submit ${draft.draftId}`]);

export function profileSubmitText(result: ProfileSubmitResult): string {
  if (result.ok) return lines([`djinni saved the changes: ${result.changed.join(', ')}.`]);
  return lines([
    'djinni does not show these changes after the POST:',
    ...result.mismatches.map(m => `  ${m.field}: expected ${m.expected}, got ${m.actual}`),
    result.changed.length > 0 && `djinni saved these changes: ${result.changed.join(', ')}.`,
  ]);
}

// The fields of a draft preview with a diff, for example a profile draft. A CV upload draft shows the file name.
// An application or a company subscription draft shows the job and the company.
const draftSummary = (draft: Draft) => {
  const preview = draft.preview as { diff?: unknown; name?: unknown; title?: unknown; company?: unknown } | null;
  if (Array.isArray(preview?.diff)) return preview.diff.map(d => (d as DiffLine).field).join(', ');
  if (typeof preview?.title === 'string') return `${preview.title} | ${String(preview.company ?? '')}`;
  return typeof preview?.name === 'string' ? preview.name : '';
};

export const draftsText = (drafts: Draft[]) =>
  drafts.length === 0
    ? lines(['No drafts.'])
    : lines(drafts.map(d => [`${d.id}  ${d.kind} | expires ${d.expiresAt}`, draftSummary(d)].filter(Boolean).join(' | ')));

const sizeText = (bytes: number) =>
  bytes < 1000 ? `${bytes} bytes` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;

export function cvListText(list: CvList): string {
  const profile = list.profileCvs.map(cv => `  ${[`${cv.id}  ${cv.name}`, cv.isDefault && 'default', cv.uploaded && `uploaded ${cv.uploaded}`].filter(Boolean).join(' | ')}`);
  const all = list.allCvs.map(cv => `  ${[`${cv.id}  ${cv.name}`, cv.uploaded && `uploaded ${cv.uploaded}`, plural(cv.sharedLinks, 'shared link')].filter(Boolean).join(' | ')}`);
  return lines([
    `CV files in the profile (${list.profileCvs.length} of ${list.profileLimit}):`,
    ...(profile.length ? profile : ['  (none)']),
    '',
    `All uploaded CV files (${list.allCvs.length}):`,
    ...(all.length ? all : ['  (none)']),
  ]);
}

export const cvRenderText = (result: RenderResult) =>
  lines([`Wrote ${result.file} (${plural(result.pages, 'page')}, ${sizeText(result.size)}). Nothing was sent to djinni.`]);

export const cvImportText = (result: ImportResult) => lines([`Copied the file to ${result.file}`]);

export const cvFileText = (draft: CvDraftResult) =>
  lines([`File: ${draft.file}`, `Name on djinni: ${draft.name}`, `Size: ${sizeText(draft.size)}`, draft.pages !== undefined && `Pages: ${draft.pages}`]);

export const cvDraftText = (draft: CvDraftResult) =>
  cvFileText(draft) +
  lines(['', `Draft ${draft.draftId} expires at ${draft.expiresAt}. Nothing was sent to djinni.`, `Upload it with: ${BIN} cv submit ${draft.draftId}`]);

export function cvSubmitText(result: CvSubmitResult, draftId: string): string {
  if (result.ok) return lines([`djinni shows the new CV file: ${result.cv.id}  ${result.cv.name}`]);
  return lines([
    `djinni shows no new CV file after the upload (${result.status === null ? 'no HTTP answer' : `HTTP ${result.status}`}).`,
    result.message && `djinni page: ${result.message}`,
    `The draft ${draftId} stays. Check the CV files with "${BIN} cv list" before you upload again.`,
  ]);
}

// ---- Applications ----

export const applicationPreviewText = (p: ApplicationPreview) =>
  lines([
    `Job: ${p.title} | ${p.company} | ${p.url}`,
    `CV: ${p.cvId === null ? 'none' : `${p.cvName ?? 'no name'} (${p.cvId})`}`,
    `Salary: ${p.salary === null ? 'the salary of the profile' : `$${p.salary}`}`,
    'Cover letter:',
    p.message || '(empty)',
  ]);

export const applicationDraftText = (draft: ApplicationDraftResult) =>
  applicationPreviewText(draft.preview) +
  lines(['', `Draft ${draft.draftId} expires at ${draft.expiresAt}. Nothing was sent to the employer.`, `Send it with: ${BIN} apply submit ${draft.draftId}`]);

export function applicationSubmitText(result: ApplicationSubmitResult, draftId: string): string {
  if (result.ok) return lines([`djinni shows the application to the job ${result.jobId}.`, result.messageThreadUrl && `Chat with the employer: ${result.messageThreadUrl}`]);
  // A failed submit with HTTP 4xx is a rejected application. Its message already tells to make a new draft, so a resend hint is wrong there.
  const rejected = result.status !== null && result.status >= 400 && result.status < 500;
  return lines([
    `djinni does not show the application (${result.status === null ? 'no HTTP answer' : `HTTP ${result.status}`}).`,
    result.message,
    !rejected && `To send the draft again after the check, run: ${BIN} apply submit ${draftId} --resend`,
  ]);
}

export const applicationsText = (list: ApplicationList) =>
  lines([
    `Applications today: ${list.sentToday} of ${list.dailyLimit} (Europe/Kyiv time).`,
    ...(list.applications.length
      ? list.applications.map(a => `${a.appliedAt}  ${a.jobId}  ${a.title} | ${a.company} | ${a.cvName ?? 'no CV'} | ${a.status ?? 'confirmed'}`)
      : ['No applications in the log.']),
  ]);

// ---- Subscriptions ----

// The field key, the label and the CLI flag of each subscription field.
const SUBSCRIPTION_FIELDS: [string, string, string][] = [
  ['name', 'Name', 'name'],
  ['category', 'Category', 'category'],
  ['salary', 'Salary', 'salary'],
  ['expYears', 'Experience', 'exp-years'],
  ['format', 'Work format', 'format'],
  ['employment', 'Employment', 'employment'],
  ['englishLevel', 'English level', 'english'],
  ['location', 'Location', 'location'],
  ['domain', 'Domain', 'domain'],
  ['keywords', 'Keywords', 'keywords'],
  ['canApplyOnly', 'Only jobs that I can apply to', 'can-apply-only'],
];

export function subscriptionOptionsText(options: SubscriptionOptions): string {
  const lists = SUBSCRIPTION_FIELDS.flatMap(([key, label, flag]) => {
    const values = (options as Record<string, unknown>)[key];
    if (!Array.isArray(values)) return [];
    return ['', `${label} (--${flag}):`, ...table((values as { value: string; label: string }[]).map(o => [o.value, o.label]))];
  });
  return lines([
    `Name (--name): at most ${options.name.maxLength} characters.`,
    `Keywords (--keywords): at most ${options.keywords.maxLength} characters.${options.keywords.example ? ` Example: ${options.keywords.example}` : ''}`,
    'Only jobs that I can apply to (--can-apply-only): a flag without a value.',
    ...lists,
  ]);
}

export const subscriptionPreviewText = (preview: SubscriptionPreview) =>
  lines(
    SUBSCRIPTION_FIELDS.map(([key, label]) => {
      const value = preview[key];
      if (value === undefined) return null;
      return `${label}: ${typeof value === 'boolean' ? (value ? 'yes' : 'no') : Array.isArray(value) ? value.join(', ') : value}`;
    }),
  );

export const companySubscriptionPreviewText = (draft: CompanySubscriptionDraftResult) =>
  lines([`Company: ${draft.preview.company} (from the job ${draft.preview.jobId} ${draft.preview.title})`]);

const subscriptionDraftLines = (draftId: string, expiresAt: string) =>
  lines(['', `Draft ${draftId} expires at ${expiresAt}. Nothing was sent to djinni.`, `Create it with: ${BIN} subs submit ${draftId}`]);

export const subscriptionDraftText = (draft: SubscriptionDraftResult) => subscriptionPreviewText(draft.preview) + subscriptionDraftLines(draft.draftId, draft.expiresAt);

export const companySubscriptionDraftText = (draft: CompanySubscriptionDraftResult) =>
  companySubscriptionPreviewText(draft) + subscriptionDraftLines(draft.draftId, draft.expiresAt);

// A request without an HTTP answer has only the message with the retry warning.
export const subscriptionSubmitText = (result: SubscriptionSubmitResult) =>
  lines([
    result.status === null ? result.message : `djinni answered HTTP ${result.status}${result.message ? `: ${result.message}` : '.'}`,
    result.status !== null && 'Check the subscriptions on https://djinni.co/my/subscriptions/',
  ]);

// ---- Inbox ----

export function inboxText(inbox: InboxList): string {
  if (inbox.threads.length === 0) return lines(['No conversations.']);
  return lines([
    ...inbox.threads.flatMap(t => [
      `${t.id}${t.unread ? '  unread' : ''}  ${[t.date, t.label, t.jobTitle].filter(Boolean).join(' | ')}`,
      `  ${t.preview}`,
    ]),
    '',
    `Read a conversation: ${BIN} inbox read <thread-id>`,
  ]);
}

const SIDE_LABEL = { candidate: 'You', recruiter: 'Employer' } as const;

export function inboxThreadText(thread: InboxThread): string {
  return lines([
    `Conversation ${thread.threadId}: ${thread.url}`,
    ...thread.messages.flatMap(m => ['', `${[SIDE_LABEL[m.side], m.author, m.date].filter(Boolean).join(', ')}:`, m.text]),
    thread.restoredUnread && '\nThe conversation is marked as unread again.',
    thread.wasUnread && !thread.restoredUnread && !thread.warning && '\nThe conversation is now marked as read.',
  ]);
}

export const markUnreadText = (result: MarkUnreadResult) =>
  lines([
    result.ok
      ? `Conversation ${result.threadId} is marked as unread.`
      : `djinni returned HTTP ${result.status}. The conversation may still be marked as read.`,
  ]);

// ---- Doctor ----

export function doctorText(report: DoctorReport): string {
  const failed = report.steps.filter(s => !s.ok).map(s => s.step);
  return lines([
    ...report.steps.map(s => `${(s.ok ? 'ok' : 'FAIL').padEnd(6)}${s.step.padEnd(15)}${s.detail}`),
    '',
    failed.length === 0
      ? `All ${report.steps.length} checks passed.`
      : `${failed.length} of ${report.steps.length} checks failed: ${failed.join(', ')}.`,
  ]);
}

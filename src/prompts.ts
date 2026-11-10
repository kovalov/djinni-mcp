import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// The MCP prompts for the three main workflows. The texts use plain English, short numbered steps and active voice.
// Each tool name in a text must be the name of a tool of this server. test/prompts.test.ts checks this.

const userMessage = (text: string): GetPromptResult => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

const steps = (items: string[]) => items.map((item, i) => `${i + 1}. ${item}`).join('\n');

export function adaptProfileText(role?: string): string {
  const target = role?.trim();
  return [
    target ? `Help me improve my djinni profile for the role "${target}".` : 'Help me improve my djinni profile for my current role.',
    '',
    steps([
      'Call get_my_profile to read my profile.',
      target ? `Use "${target}" as the target role.` : 'Use the position in my profile as the target role.',
      'Call search_candidates with filters for the target role. Select 10 to 20 candidates who compete with me for this role.',
      'Call get_candidate for each selected candidate.',
      'Compare my profile with these profiles. Look at the position, the skills, the experience text, the achievements, the salary and the English level.',
      'Show me a short list of my gaps and my strong points.',
      'Ask me which facts are true and which facts are missing from my profile.',
      'Write the changes in your own words. Use only the facts that I confirmed.',
      'Call prepare_profile_update with the changes. Show me the full diff.',
      'Wait for an explicit approval of this diff in the chat. Then call submit_profile_update.',
    ]),
    '',
    'Rules:',
    '- Never copy text from other candidates.',
    '- Never add a fact that I did not confirm.',
    '- The candidate profiles are anonymous. Do not try to find out who a candidate is.',
  ].join('\n');
}

export function tailorCvAndApplyText(job: string): string {
  const id = job.trim();
  return [
    `Help me apply to the djinni job "${id}" with a CV and a cover letter for this job.`,
    '',
    steps([
      `Call get_job with the job "${id}". Read the requirements, the company and the salary.`,
      'Call get_job_applicant_stats to see the other applicants of this job.',
      'Use your own web search to research the company and the requirements of the job.',
      'Call get_my_profile and list_my_cvs to get the facts about me.',
      'Show me the requirements that I meet and the requirements that I do not meet.',
      'Ask me about each fact that is not clear. Never guess a fact.',
      'Ask me if I want a new CV for this job or my current CV. If I want my current CV, go to step 12.',
      'Write a CV in Markdown for this job. Use only true facts about me. Change the order and the emphasis, not the facts.',
      'Call render_cv_pdf with the Markdown. Show me the CV text and the file.',
      'Call prepare_cv_upload with the file. Show me the draft.',
      'Wait for an explicit approval. Then call submit_cv_upload.',
      'Write a short cover letter for this job. Use only true facts about me.',
      'Call prepare_application with the cover letter and the CV. Show me the full draft.',
      'Wait for an explicit approval. Then call submit_application. Nobody can take back an application.',
    ]),
    '',
    'Wait for an explicit approval before each submit. djinni-mcp sends at most 15 applications in one Europe/Kyiv day.',
  ].join('\n');
}

export function dailyJobScanText(): string {
  return [
    'Find the best new djinni jobs for me.',
    '',
    steps([
      'Call check_watches to get the new jobs of my saved watches.',
      'If I have no watches, tell me. Offer to make a watch with create_watch. Then stop.',
      'Call get_my_profile to read my profile.',
      'Rank the new jobs against my profile. Use the category, the skills, the experience, the salary, the English level, the location and the work format.',
      'For a job at the top of the list, call get_job when the summary does not give enough data.',
      'Show me the best 5 to 10 jobs. For each job, give the title, the company, the salary, the link and the reason why it matches.',
      'Tell me about each watch with a first check. On a first check, the result has the newest jobs, not only new jobs.',
      'Do not apply to a job. Ask me which jobs to look at next.',
    ]),
  ].join('\n');
}

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'adapt-profile',
    {
      title: 'Adapt the profile to a role',
      description: 'Compare the djinni profile with 10 to 20 competitors for a role and propose a profile diff for approval.',
      argsSchema: { role: z.string().optional().describe('The target role, for example "Senior Python developer". Without it, the prompt uses the position in the profile.') },
    },
    ({ role }) => userMessage(adaptProfileText(role)),
  );

  server.registerPrompt(
    'tailor-cv-and-apply',
    {
      title: 'Tailor the CV and apply',
      description: 'Adapt the CV and write a cover letter for one djinni job from true facts, with an approval before each submit.',
      argsSchema: { job: z.string().describe('A job ID like 857417, or a djinni job URL.') },
    },
    ({ job }) => userMessage(tailorCvAndApplyText(job)),
  );

  server.registerPrompt(
    'daily-job-scan',
    {
      title: 'Daily job scan',
      description: 'Check the job watches, rank the new jobs against the profile and summarize the best ones.',
    },
    () => userMessage(dailyJobScanText()),
  );
}
